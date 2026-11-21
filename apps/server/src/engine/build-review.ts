/**
 * The build workflow's own review, recorded for the autonomous merge gate.
 *
 * `build.yaml` runs an independent reviewer loop BEFORE the `pr` phase opens the
 * PR, so by the time the PR exists the verdict is already known but nothing
 * GitHub-side says so. This module pins that verdict to the commit it is a
 * statement about — the PR head AFTER the `pr` phase pushed, not the reviewer's
 * workspace SHA — and posts it as `last-light/review` on that commit, so branch
 * protection sees the same check a `pr-review` run would have produced.
 *
 * The record lives in run scratch (`buildReview`); the merge gate reads it back
 * with {@link readBuildReview} and fails closed on a missing or stale one.
 */

import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import type { GitHubClient } from "./github/github.js";
import { renderTemplate, type TemplateContext } from "lastlight-workflow-engine";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExecutorConfig } from "lastlight-workflow-engine";
import { hostGit, sanitizeCheckout } from "./host-git.js";
import { REVIEW_CHECK_NAME } from "./review-check.js";
import { logger } from "../logging/logger.js";

const log = logger("build-review");

/** `workflow_runs.scratch` key holding {@link BuildReviewRecord}. */
export const BUILD_REVIEW_SCRATCH_KEY = "buildReview";

export interface BuildReviewRecord {
  prNumber: number;
  /** The PR head the verdict was posted against. */
  reviewedSha: string;
  verdict: "APPROVED" | "REQUEST_CHANGES";
  /** Where the verdict artifact (or, failing that, the run) can be read. */
  verdictUrl: string;
  recordedAt: string;
}

/**
 * Read the record off a run row. Scratch persists across releases, so the shape
 * is validated rather than trusted: anything malformed is "no record".
 */
export function readBuildReview(run: WorkflowRun): BuildReviewRecord | null {
  const raw = (run.scratch ?? {})[BUILD_REVIEW_SCRATCH_KEY];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.prNumber !== "number" || !Number.isInteger(r.prNumber) || r.prNumber <= 0) return null;
  if (typeof r.reviewedSha !== "string" || !r.reviewedSha) return null;
  if (r.verdict !== "APPROVED" && r.verdict !== "REQUEST_CHANGES") return null;
  if (typeof r.verdictUrl !== "string" || typeof r.recordedAt !== "string") return null;
  return {
    prNumber: r.prNumber,
    reviewedSha: r.reviewedSha,
    verdict: r.verdict,
    verdictUrl: r.verdictUrl,
    recordedAt: r.recordedAt,
  };
}

export async function recordBuildReview(
  db: StateDb,
  runId: string,
  rec: BuildReviewRecord,
): Promise<void> {
  await db.runs.mergeScratch(runId, { [BUILD_REVIEW_SCRATCH_KEY]: rec });
}

export interface FinalizeBuildReviewArgs {
  runId: string;
  owner: string;
  repo: string;
  /** The PR the `pr` phase claims to have opened — agent-supplied, so verified. */
  prNumber: number;
  /** The reviewer loop's `output_var` verdict (`review.approved`). */
  approved: boolean;
  verdictUrl: string;
  /** The branch this run built and pushed; the PR's head must be exactly it. */
  branch: string;
  /** The workspace HEAD the reviewer's final pass reviewed. */
  reviewedHeadSha?: string;
}

/**
 * Record the build review against the PR head and post the check there.
 *
 * Two bindings keep the record honest, because the merge gate acts on it
 * unattended:
 *
 * 1. The PR number comes from the agent's `pr` phase output, so the PR is
 *    fetched and must be THIS build's: head ref equals the run's branch, head
 *    repo is the target repo (not a fork), author is our bot, base is the
 *    default branch. Otherwise nothing is recorded or posted.
 * 2. An approval is a statement about the commit the reviewer saw. The `pr`
 *    phase can push more, so an APPROVED verdict is recorded only when the PR
 *    head equals the captured reviewed SHA (a missing capture also refuses).
 *    REQUEST_CHANGES carries no authority and is recorded either way.
 *
 * Never throws: a failure to record or post must not fail a run that already
 * succeeded. The gate fails closed on a missing record. The record is written
 * before the check is posted, so a failed post still leaves the gate its evidence.
 */
export async function finalizeBuildReview(
  args: FinalizeBuildReviewArgs,
  deps: { db: StateDb; github: GitHubClient | null; botLogin?: string },
): Promise<BuildReviewRecord | null> {
  const { github, db } = deps;
  if (!github || !args.prNumber) return null;
  const verdict = args.approved ? "APPROVED" : "REQUEST_CHANGES";
  const ctx = { runId: args.runId, prNumber: args.prNumber };
  try {
    const refuse = (reason: string): null => {
      log.warn("Not recording build review", { ...ctx, reason });
      return null;
    };
    if (!args.branch) return refuse("the run's branch is unknown");
    if (!deps.botLogin) return refuse("the bot login is unknown");
    const pr = await github.getPullRequest(args.owner, args.repo, args.prNumber);
    if (pr.head?.ref !== args.branch) return refuse(`PR head ref ${pr.head?.ref} is not the run branch ${args.branch}`);
    if (pr.head?.repo?.full_name?.toLowerCase() !== `${args.owner}/${args.repo}`.toLowerCase()) {
      return refuse(`PR head repo ${pr.head?.repo?.full_name} is not ${args.owner}/${args.repo}`);
    }
    if (pr.user?.login !== deps.botLogin) return refuse(`PR author ${pr.user?.login} is not ${deps.botLogin}`);
    const defaultBranch = await github.getDefaultBranch(args.owner, args.repo);
    if (!defaultBranch || pr.base?.ref !== defaultBranch) {
      return refuse(`PR base ${pr.base?.ref} is not the default branch ${defaultBranch}`);
    }
    const reviewedSha = pr.head?.sha;
    if (!reviewedSha) return refuse("the PR head SHA is unknown");
    if (args.approved) {
      if (!args.reviewedHeadSha) return refuse("no reviewed commit was captured for the approval");
      if (reviewedSha !== args.reviewedHeadSha) {
        return refuse(`PR head ${reviewedSha} is not the reviewed commit ${args.reviewedHeadSha}`);
      }
    }
    const rec: BuildReviewRecord = {
      prNumber: args.prNumber,
      reviewedSha,
      verdict,
      verdictUrl: args.verdictUrl,
      recordedAt: new Date().toISOString(),
    };
    await recordBuildReview(db, args.runId, rec);
    try {
      await github.createCheckRun(args.owner, args.repo, reviewedSha, REVIEW_CHECK_NAME, {
        status: "completed",
        conclusion: args.approved ? "success" : "failure",
        ...(args.verdictUrl ? { detailsUrl: args.verdictUrl } : {}),
        output: args.approved
          ? { title: "Review approved", summary: `The build's independent review approved this PR. Verdict: ${args.verdictUrl}` }
          : {
              title: "Review requested changes",
              summary: `The build's independent review still had unresolved findings after its fix cycles. Verdict: ${args.verdictUrl}`,
            },
      });
    } catch (err: unknown) {
      log.warn("Failed to post build review check", { ...ctx, err });
    }
    return rec;
  } catch (err: unknown) {
    log.warn("Failed to record build review", { ...ctx, err });
    return null;
  }
}

/** The build workflow, whose `reviewer` loop emits `output_var: review`. */
export const BUILD_WORKFLOW = "build";

/**
 * The run-finish hook shared by a fresh dispatch (`simple.ts`) and a resume
 * (`resume.ts`): record and post the review when a build run opened a PR.
 *
 * Applies only to a SUCCEEDED `build` run with a PR number and a reviewer
 * verdict in its outputs. A run that resumed past the reviewer carries no
 * verdict here, so it records nothing and the gate fails closed.
 */
export async function finalizeBuildReviewForRun(
  args: {
    workflowName: string;
    result: { success: boolean; paused?: boolean; prNumber?: number; review?: unknown };
    ctx: TemplateContext;
    runId: string;
    /** Dashboard link for the run, used when the verdict artifact has no URL. */
    runUrl?: string;
  },
  deps: { db: StateDb; github: () => GitHubClient | null; botLogin?: string },
): Promise<BuildReviewRecord | null> {
  const { result } = args;
  if (args.workflowName !== BUILD_WORKFLOW || !result.success || result.paused) return null;
  if (!result.prNumber) return null;
  const review = result.review as { approved?: unknown; headSha?: unknown } | undefined;
  if (!review || typeof review.approved !== "boolean") return null;
  try {
    const artifact = renderTemplate("{{artifactUrl reviewer-verdict.md}}", args.ctx).trim();
    const github = deps.github();
    const rec = await finalizeBuildReview(
      {
        runId: args.runId,
        owner: args.ctx.owner,
        repo: args.ctx.repo,
        prNumber: result.prNumber,
        approved: review.approved,
        verdictUrl: artifact || args.runUrl || "",
        branch: typeof args.ctx.branch === "string" ? args.ctx.branch : "",
        reviewedHeadSha: typeof review.headSha === "string" && review.headSha ? review.headSha : undefined,
      },
      { db: deps.db, github, botLogin: deps.botLogin },
    );
    if (rec?.verdict === "APPROVED" && github && deps.botLogin) {
      triggerMergeEvaluation(
        { github, db: deps.db, botLogin: deps.botLogin },
        `${args.ctx.owner}/${args.ctx.repo}`,
        rec.prNumber,
        args.runId,
      );
    }
    return rec;
  } catch (err: unknown) {
    log.warn("Build review hook failed", { runId: args.runId, err });
    return null;
  }
}

/**
 * The `build-finished` merge trigger: the record this hook just wrote is what
 * the merge gate reads, so this is the first moment the gate can say yes.
 * (A terminal-run observer would fire before the record exists.)
 *
 * Fire-and-forget: the run is already `succeeded`, and nothing the gate does
 * may change that. A failure is logged; the 20-minute sweep is the retry.
 */
function triggerMergeEvaluation(
  deps: { github: GitHubClient; db: StateDb; botLogin: string },
  repo: string,
  prNumber: number,
  runId: string,
): void {
  // Imported lazily: the executor reaches the PR state machine and, through it,
  // the sandbox modules — an edge this module (which the runner loads) must not
  // grow, and one that would also close a cycle back to `readBuildReview`.
  void import("./build-merge.js")
    .then(({ evaluateBuildMerge }) => evaluateBuildMerge(deps, repo, prNumber, "build-finished"))
    .catch((err: unknown) => {
      log.warn("Merge evaluation after the build failed", { runId, repo, prNumber, err });
    });
}

/**
 * The commit the reviewer judged, read by the harness — or undefined when it
 * cannot be vouched for. The agent controls the workspace, so HEAD alone proves
 * nothing: a dirty tree means the code the reviewer saw differs from what is
 * committed. Capture succeeds only when the BUILD's own checkout
 * (`<sandboxDir>/<taskId>/<repo>`, never the pr-review layout fallback
 * `resolveHostRepoDir` can return) has a real HEAD commit and nothing
 * uncommitted or untracked. Otherwise undefined, which makes an approval
 * unrecordable, with one warning naming the reason.
 */
export function readWorkspaceHead(
  config: Pick<ExecutorConfig, "sandboxDir" | "stateDir">,
  taskId: string,
  owner: string,
  repo: string,
): string | undefined {
  const refuse = (reason: "dirty-tree" | "no-commit" | "no-checkout", err?: unknown): undefined => {
    log.warn("Not capturing the reviewed commit", { taskId, repo: `${owner}/${repo}`, reason, ...(err ? { err } : {}) });
    return undefined;
  };
  const repoDir = resolve(config.sandboxDir || join(config.stateDir || "data", "sandboxes"), taskId, repo);
  if (!existsSync(join(repoDir, ".git"))) return refuse("no-checkout");
  try {
    // The agent has had this checkout: make its `.git` inert before host git runs.
    sanitizeCheckout(dirname(repoDir), repoDir, `https://github.com/${owner}/${repo}.git`);
  } catch (err: unknown) {
    return refuse("no-checkout", err);
  }
  const run = (args: string[]) =>
    hostGit(repoDir, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    run(["cat-file", "-e", "HEAD^{commit}"]);
  } catch {
    return refuse("no-commit");
  }
  try {
    if (run(["status", "--porcelain", "--untracked-files=all"]).trim() !== "") return refuse("dirty-tree");
    const sha = run(["rev-parse", "HEAD"]).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : refuse("no-commit");
  } catch (err: unknown) {
    // git could not say whether the tree is clean: do not vouch for it.
    return refuse("dirty-tree", err);
  }
}
