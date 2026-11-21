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
  /** The PR the `pr` phase opened. */
  prNumber: number;
  /** The reviewer loop's `output_var` verdict (`review.approved`). */
  approved: boolean;
  verdictUrl: string;
}

/**
 * Record the build review against the PR head and post the check there.
 *
 * Never throws: a failure to record or post must not fail a run that already
 * succeeded. The gate fails closed on a missing record, so losing one costs a
 * human merge, not safety. The record is written before the check is posted, so
 * a failed post still leaves the gate its evidence.
 */
export async function finalizeBuildReview(
  args: FinalizeBuildReviewArgs,
  deps: { db: StateDb; github: GitHubClient | null },
): Promise<BuildReviewRecord | null> {
  const { github, db } = deps;
  if (!github || !args.prNumber) return null;
  const verdict = args.approved ? "APPROVED" : "REQUEST_CHANGES";
  try {
    const reviewedSha = await github.getPullRequestHeadSha(args.owner, args.repo, args.prNumber);
    if (!reviewedSha) return null;
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
      log.warn("Failed to post build review check", { runId: args.runId, prNumber: args.prNumber, err });
    }
    return rec;
  } catch (err: unknown) {
    log.warn("Failed to record build review", { runId: args.runId, prNumber: args.prNumber, err });
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
  deps: { db: StateDb; github: () => GitHubClient | null },
): Promise<BuildReviewRecord | null> {
  const { result } = args;
  if (args.workflowName !== BUILD_WORKFLOW || !result.success || result.paused) return null;
  if (!result.prNumber) return null;
  const review = result.review as { approved?: unknown } | undefined;
  if (!review || typeof review.approved !== "boolean") return null;
  try {
    const artifact = renderTemplate("{{artifactUrl reviewer-verdict.md}}", args.ctx).trim();
    return await finalizeBuildReview(
      {
        runId: args.runId,
        owner: args.ctx.owner,
        repo: args.ctx.repo,
        prNumber: result.prNumber,
        approved: review.approved,
        verdictUrl: artifact || args.runUrl || "",
      },
      { db: deps.db, github: deps.github() },
    );
  } catch (err: unknown) {
    log.warn("Build review hook failed", { runId: args.runId, err });
    return null;
  }
}
