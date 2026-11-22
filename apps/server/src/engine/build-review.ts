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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExecutorConfig } from "lastlight-workflow-engine";
import { hostGit, sanitizeCheckout } from "./host-git.js";
import { REVIEW_CHECK_NAME } from "./review-check.js";
import { appendDecision, hasCommented } from "./build-merge-ledger.js";
import { getAutonomyConfig, isAutonomousRepo, isMergeRepo } from "../config/config.js";
import { resolveAutonomyMerge } from "../workflows/autonomy-merge.js";
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

/** Why {@link captureWorkspaceHead} would not vouch for the reviewer's commit. */
export const CAPTURE_REFUSALS = [
  "dirty-tree",
  "no-commit",
  "no-checkout",
  "submodules",
  "index-flags",
  "temp-index",
] as const;
export type CaptureRefusal = (typeof CAPTURE_REFUSALS)[number];

/**
 * Why an APPROVED verdict was not recorded: a fixed code, never agent text. The
 * capture codes come from {@link captureWorkspaceHead}; `no-capture` is a
 * missing capture with no known cause (a failed review pass, a resume).
 */
export type ApprovalRefusal =
  | CaptureRefusal
  | "no-capture"
  | "no-branch"
  | "no-bot-login"
  | "no-head-sha"
  | "head-ref-mismatch"
  | "fork-head"
  | "author-mismatch"
  | "base-not-default"
  | "head-not-reviewed"
  | "record-failed";

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
  /** Why the reviewed HEAD was not captured, when it was not. */
  reviewedHeadRefusal?: CaptureRefusal;
  /**
   * The merge gate owns this run's PR (`autonomyMerge.gate`). An approval that
   * cannot be recorded then gets one PR comment, because the gate can never
   * merge it and would otherwise say nothing.
   */
  gateRun?: boolean;
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
 *
 * On a gate run, an APPROVED verdict that is refused gets one PR comment per
 * (PR, head) naming the refusal code, so a human knows the gate will not merge
 * it ({@link commentApprovalRefused}).
 */
export async function finalizeBuildReview(
  args: FinalizeBuildReviewArgs,
  deps: { db: StateDb; github: GitHubClient | null; botLogin?: string },
): Promise<BuildReviewRecord | null> {
  const { github, db } = deps;
  if (!github || !args.prNumber) return null;
  const verdict = args.approved ? "APPROVED" : "REQUEST_CHANGES";
  const ctx = { runId: args.runId, prNumber: args.prNumber };
  // What a refusal comment needs: the PR as read, when it was read.
  let prRead: Awaited<ReturnType<GitHubClient["getPullRequest"]>> | undefined;
  const refuse = async (code: ApprovalRefusal, reason: string): Promise<null> => {
    log.warn("Not recording build review", { ...ctx, code, reason });
    if (args.approved && args.gateRun) {
      await commentApprovalRefused(args, { db, github, botLogin: deps.botLogin }, prRead, code);
    }
    return null;
  };
  try {
    if (!args.branch) return await refuse("no-branch", "the run's branch is unknown");
    if (!deps.botLogin) return await refuse("no-bot-login", "the bot login is unknown");
    const pr = await github.getPullRequest(args.owner, args.repo, args.prNumber);
    prRead = pr;
    if (pr.head?.ref !== args.branch) {
      return await refuse("head-ref-mismatch", `PR head ref ${pr.head?.ref} is not the run branch ${args.branch}`);
    }
    if (pr.head?.repo?.full_name?.toLowerCase() !== `${args.owner}/${args.repo}`.toLowerCase()) {
      return await refuse("fork-head", `PR head repo ${pr.head?.repo?.full_name} is not ${args.owner}/${args.repo}`);
    }
    if (pr.user?.login !== deps.botLogin) {
      return await refuse("author-mismatch", `PR author ${pr.user?.login} is not ${deps.botLogin}`);
    }
    const defaultBranch = await github.getDefaultBranch(args.owner, args.repo);
    if (!defaultBranch || pr.base?.ref !== defaultBranch) {
      return await refuse("base-not-default", `PR base ${pr.base?.ref} is not the default branch ${defaultBranch}`);
    }
    const reviewedSha = pr.head?.sha;
    if (!reviewedSha) return await refuse("no-head-sha", "the PR head SHA is unknown");
    if (args.approved) {
      if (!args.reviewedHeadSha) {
        return await refuse(
          args.reviewedHeadRefusal ?? "no-capture",
          "no reviewed commit was captured for the approval",
        );
      }
      if (reviewedSha !== args.reviewedHeadSha) {
        return await refuse("head-not-reviewed", `PR head ${reviewedSha} is not the reviewed commit ${args.reviewedHeadSha}`);
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
    // `refuse` never throws, so this is a read or the record write.
    return refuse("record-failed", "the PR or the record could not be read or written");
  }
}

/** The ledger reason case of an approval the gate could not bind. */
const APPROVAL_UNRECORDED_CASE = "approval-unrecorded";

/**
 * One PR comment for a gate run whose APPROVED verdict was not recorded: the
 * gate will never merge it, so a human must. Deduped per (PR, head) through
 * the run's merge-decision ledger, the same mechanism the merge executor's
 * hand-offs use. Only on this build's own PR: the bot's, same-repo, with the
 * run's branch as its head. The PR number is agent-supplied, so a refusal for
 * a PR someone else opened, or for another bot PR (`head-ref-mismatch`), must
 * not comment there; it logs a warning instead. Never throws.
 */
async function commentApprovalRefused(
  args: FinalizeBuildReviewArgs,
  deps: { db: StateDb; github: GitHubClient; botLogin?: string },
  pr: Awaited<ReturnType<GitHubClient["getPullRequest"]>> | undefined,
  code: ApprovalRefusal,
): Promise<void> {
  const ctx = { runId: args.runId, prNumber: args.prNumber, code };
  try {
    const headSha = pr?.head?.sha;
    if (!pr || !headSha) return; // the PR could not be read: nowhere safe to say it
    const ownPr =
      !!deps.botLogin &&
      pr.user?.login === deps.botLogin &&
      pr.head?.repo?.full_name?.toLowerCase() === `${args.owner}/${args.repo}`.toLowerCase() &&
      !!args.branch &&
      pr.head?.ref === args.branch;
    if (!ownPr) {
      log.warn("Approval not recorded on a PR that is not this build's; not commenting", {
        ...ctx,
        headRef: pr.head?.ref,
        branch: args.branch,
        author: pr.user?.login,
      });
      return;
    }
    const reason = `${APPROVAL_UNRECORDED_CASE}: ${code}`;
    const run = await deps.db.runs.getRun(args.runId);
    if (run && hasCommented(run, headSha, reason)) return;
    const body = [
      "The merge gate will not merge this PR on its own: the build review approved it, but the " +
        `approval could not be bound to the reviewed commit (\`${reason}\`).`,
      "",
      "A human will need to merge it, after checking the PR head is what the review approved.",
      ...(args.verdictUrl ? ["", `Build review: [verdict](${args.verdictUrl})`] : []),
    ].join("\n");
    await deps.github.postComment(args.owner, args.repo, args.prNumber, body);
    log.info("Gate run approval not recorded; handed to a human", { ...ctx, headSha });
    if (run) {
      await appendDecision(deps.db, run, {
        trigger: "build-finished",
        decision: "hand-off",
        reason,
        headSha,
        commented: true,
      });
    }
  } catch (err: unknown) {
    log.warn("Failed to comment on an unrecorded gate approval", { ...ctx, err });
  }
}

/**
 * The merge gate owns this run's PR. A fresh dispatch carries
 * `autonomyMerge.gate` on its context; a resumed one carries only the dispatch
 * markers (`_stage`), so the policy is resolved from them the way the merge
 * executor resolves it.
 */
function isGateRun(ctx: TemplateContext): boolean {
  const projected = (ctx as Record<string, unknown>).autonomyMerge as { gate?: unknown } | undefined;
  if (projected && typeof projected === "object") return projected.gate === true;
  const repo = `${ctx.owner}/${ctx.repo}`;
  return resolveAutonomyMerge(
    ctx as Record<string, unknown>,
    getAutonomyConfig().stages,
    isMergeRepo(repo) && isAutonomousRepo(repo),
  ).gate;
}

function captureRefusal(raw: unknown): CaptureRefusal | undefined {
  if (raw === undefined) return undefined;
  return (CAPTURE_REFUSALS as readonly unknown[]).includes(raw) ? (raw as CaptureRefusal) : undefined;
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
  const review = result.review as { approved?: unknown; headSha?: unknown; headRefusal?: unknown } | undefined;
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
        reviewedHeadRefusal: captureRefusal(review.headRefusal),
        gateRun: isGateRun(args.ctx),
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
 * uncommitted or untracked (ignored files never reach the commit, so they do
 * not count). Otherwise undefined, which makes an approval unrecordable, with
 * one warning naming the reason.
 *
 * Two shapes are refused before any status runs:
 *  - `submodules`: a `.git/modules` entry or a gitlink (mode 160000) in the
 *    index. `git status` recurses into submodules, and a submodule's own config
 *    (under `.git/modules/*`, or wherever its gitfile points) is not sanitized,
 *    so its `filter.*` drivers would run on the host.
 *  - `index-flags`: an entry marked assume-unchanged or skip-worktree, which
 *    makes status report a modified file as clean.
 * `ls-files` reads only the index: it starts no subprocess and does not
 * recurse (`submodule.recurse` does not apply to it). The dirty check itself
 * runs against a fresh temp index (`temp-index` if that cannot be built).
 */
export function readWorkspaceHead(
  config: Pick<ExecutorConfig, "sandboxDir" | "stateDir">,
  taskId: string,
  owner: string,
  repo: string,
): string | undefined {
  const got = captureWorkspaceHead(config, taskId, owner, repo);
  return "sha" in got ? got.sha : undefined;
}

/**
 * {@link readWorkspaceHead} with the refusal named: `{ sha }`, or `{ refused }`
 * carrying the fixed code the warning logged. The runner passes the code on, so
 * a gate run's refusal comment can say why.
 */
export function captureWorkspaceHead(
  config: Pick<ExecutorConfig, "sandboxDir" | "stateDir">,
  taskId: string,
  owner: string,
  repo: string,
): { sha: string } | { refused: CaptureRefusal } {
  const refuse = (reason: CaptureRefusal, err?: unknown): { refused: CaptureRefusal } => {
    log.warn("Not capturing the reviewed commit", { taskId, repo: `${owner}/${repo}`, reason, ...(err ? { err } : {}) });
    return { refused: reason };
  };
  const repoDir = resolve(config.sandboxDir || join(config.stateDir || "data", "sandboxes"), taskId, repo);
  if (!existsSync(join(repoDir, ".git"))) return refuse("no-checkout");
  try {
    // The agent has had this checkout: make its `.git` inert before host git runs.
    sanitizeCheckout(dirname(repoDir), repoDir, `https://github.com/${owner}/${repo}.git`);
  } catch (err: unknown) {
    return refuse("no-checkout", err);
  }
  // `ls-files` lists every index entry: give it room for a large repository.
  // `indexFile` points git at the harness's temp index instead of `.git/index`.
  const run = (args: string[], indexFile?: string) =>
    hostGit(repoDir, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
      ...(indexFile ? { env: { ...process.env, GIT_INDEX_FILE: indexFile } } : {}),
    });
  // NUL-separated `ls-files` records; a failure to list means the index cannot be vouched for.
  const indexEntries = (flag: "-s" | "-v", indexFile?: string): string[] =>
    run(["ls-files", flag, "-z"], indexFile).split("\0").filter(Boolean);
  // `<mode> <object> <stage>\t<path>`
  const hasGitlink = (indexFile?: string) => indexEntries("-s", indexFile).some((e) => e.startsWith("160000 "));
  try {
    if (existsSync(join(repoDir, ".git", "modules"))) return refuse("submodules");
    if (hasGitlink()) return refuse("submodules");
  } catch (err: unknown) {
    return refuse("submodules", err);
  }
  try {
    // `<tag> <path>`: lowercase = assume-unchanged (`s` when skip-worktree too), `S` = skip-worktree.
    if (indexEntries("-v").some((e) => /^[a-zS] /.test(e))) return refuse("index-flags");
  } catch (err: unknown) {
    return refuse("index-flags", err);
  }
  let sha: string;
  try {
    run(["cat-file", "-e", "HEAD^{commit}"]);
    sha = run(["rev-parse", "HEAD^{commit}"]).trim();
  } catch {
    return refuse("no-commit");
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) return refuse("no-commit");

  // The agent wrote `.git/index`, and status trusts its stat cache: an entry
  // holding HEAD's blob with a modified file's stat reads as clean. So the tree
  // is checked against a fresh index built from `sha` outside the checkout. It
  // has no stat cache and no flags, so status must hash every file against HEAD
  // (a HEAD that moved since `sha` shows as a staged change).
  let indexDir: string | undefined;
  try {
    let indexFile: string;
    try {
      indexDir = mkdtempSync(join(tmpdir(), "lastlight-review-index-"));
      indexFile = join(indexDir, "index");
      run(["read-tree", sha], indexFile);
    } catch (err: unknown) {
      return refuse("temp-index", err);
    }
    try {
      // A gitlink in HEAD that the agent's index left out.
      if (hasGitlink(indexFile)) return refuse("submodules");
    } catch (err: unknown) {
      return refuse("submodules", err);
    }
    try {
      // Submodules were refused above; never recurse into one regardless.
      const status = ["-c", "submodule.recurse=false", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"];
      return run(status, indexFile).trim() === "" ? { sha } : refuse("dirty-tree");
    } catch (err: unknown) {
      // git could not say whether the tree is clean: do not vouch for it.
      return refuse("dirty-tree", err);
    }
  } finally {
    if (indexDir) {
      try {
        rmSync(indexDir, { recursive: true, force: true });
      } catch (err: unknown) {
        // The verdict stands; a stray temp dir holds only a copy of HEAD's tree listing.
        log.debug("Could not remove the temp index", { taskId, indexDir, err });
      }
    }
  }
}
