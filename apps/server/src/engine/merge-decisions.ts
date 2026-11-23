/**
 * The autonomous merge gate's decision for a PR a build run opened — PURE over
 * a resolved snapshot, in the style of `pr-decisions.ts`.
 *
 * `mayMerge` there is deliberately NOT reused: it answers the dependency-PR
 * question and is driven by `DependenciesConfig.requireSettledChecks`, which has
 * no meaning for this gate (checks are always required here unless
 * `merge.minSettledChecks` is 0).
 *
 * `wait`     — may become mergeable without a human (or is a safe skip).
 * `hand-off` — needs a human.
 * `merge`    — every condition holds on the reviewed head (or on a head that
 *              adds only the build's own notes to it).
 *
 * Fail closed: the PR merges only when nothing below objects, and
 * `mergeableState` is exactly `"clean"`.
 */

import type { MergeConfig } from "../config/config.js";
import type { BuildReviewRecord } from "./build-review.js";
import type { Decision } from "./pr-decisions.js";
import type { PrState } from "./pr-state.js";
import { isInOwnNotesDir, notesOnlyAdvance, type CommitComparison } from "./own-notes.js";

export type BuildMergeDecision = "merge" | "wait" | "hand-off";

export interface BuildMergeInputs {
  state: PrState;
  review: BuildReviewRecord | null;
  /** Changed paths incl. previous names; `null` = completeness unconfirmed. */
  changedPaths: readonly string[] | null;
  /**
   * The issue whose build run recorded the review. Its own artifact dir,
   * `.lastlight/issue-<issueNumber>/`, is exempt from protected-path matching.
   */
  issueNumber: number;
  prLabels: readonly string[];
  /** Live labels of the closing issue the build ran for. A hold there holds the PR too. */
  issueLabels: readonly string[];
  /**
   * The instance hold label (`getHoldLabel()`, default `lastlight-ignore`). On
   * the PR or the issue it stops the merge like every other action.
   */
  holdLabel: string;
  /** `resolveAutonomyMerge(...).gate` */
  mergeEnabled: boolean;
  /** The PR was opened by a build run of this instance. */
  fromBuildRun: boolean;
  /** GitHub's `mergeable_state`, `null` when not yet computed. */
  mergeableState: string | null;
  /** The PR targets the repo's default branch. */
  baseIsDefault: boolean;
  /**
   * GitHub's `reviewedSha...headSha` comparison, read only when the head moved
   * past the reviewed commit. `"error"` = the compare call failed (wait, never
   * merge); absent/null = not read (the moved head is a stale review).
   */
  headComparison?: CommitComparison | "error" | null;
}

/** `**` = any depth (incl. zero segments), `*` = within one segment, rest literal. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\\/-]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** GitHub label names are case-insensitive. */
function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

/** The first of `wanted` that `labels` carries, compared case-insensitively. */
function findLabel(labels: readonly string[], wanted: readonly string[]): string | undefined {
  const have = new Set(labels.map(labelKey));
  return wanted.find((w) => w.trim() !== "" && have.has(labelKey(w)));
}

export function mayMergeBuild(
  i: BuildMergeInputs,
  cfg: MergeConfig,
): Decision<BuildMergeDecision> {
  const { state, review } = i;
  const inputs: Record<string, unknown> = {
    mergeEnabled: i.mergeEnabled,
    authorIsOurs: state.authorIsOurs,
    fromBuildRun: i.fromBuildRun,
    isDraft: state.isDraft,
    baseIsDefault: i.baseIsDefault,
    headSha: state.headSha,
    reviewedSha: review?.reviewedSha ?? null,
    verdict: review?.verdict ?? null,
    checksState: state.checksState,
    settledCheckCount: state.settledCheckCount,
    minSettledChecks: cfg.minSettledChecks,
    mergeableState: i.mergeableState,
  };
  const out = (decision: BuildMergeDecision, reason: string): Decision<BuildMergeDecision> => ({
    decision,
    reason,
    inputs,
  });

  // 1. Cheap disqualifiers — safe skips.
  if (!i.mergeEnabled) return out("wait", "merge-disabled: autonomy does not gate merges for this stage");
  if (!state.authorIsOurs) return out("wait", "not-ours: the PR was not opened by this bot");
  if (!i.fromBuildRun) return out("wait", "not-from-build: the PR was not opened by a build run of this instance");
  if (state.isDraft) return out("wait", "draft: the PR is still a draft");
  if (!i.baseIsDefault) return out("wait", "not-default-base: the PR does not target the default branch");

  // 2. Needs a human. The instance hold label first: it means "stop acting on
  // this subject", so the executor hands off without a comment.
  const onHoldPr = findLabel(i.prLabels, [i.holdLabel]);
  const onHoldIssue = onHoldPr === undefined ? findLabel(i.issueLabels, [i.holdLabel]) : undefined;
  if (onHoldPr !== undefined) return out("hand-off", `on-hold: PR carries "${onHoldPr}"`);
  if (onHoldIssue !== undefined) return out("hand-off", `on-hold: the closing issue carries "${onHoldIssue}"`);
  const holdPr = findLabel(i.prLabels, cfg.holdLabels);
  if (holdPr !== undefined) return out("hand-off", `hold-label: PR carries "${holdPr}"`);
  const holdIssue = findLabel(i.issueLabels, cfg.holdLabels);
  if (holdIssue !== undefined) return out("hand-off", `hold-label: the closing issue carries "${holdIssue}"`);

  if (i.changedPaths === null) {
    return out("hand-off", "paths-unknown: the changed-file list could not be confirmed complete");
  }
  // The build commits its own run notes under `.lastlight/issue-<N>/`, which
  // the default `.lastlight/**` pattern would otherwise protect, so no build PR
  // could ever merge. Exempt exactly that dir by excluding its paths from
  // `changedPaths` BEFORE matching (so it holds for every pattern, a repo's own
  // added ones included). `changedPaths` is a flat list that already carries
  // each rename's previous name, so a rename of a protected file into the dir
  // still leaves the protected previous path to match.
  const globs = cfg.protectedPaths.map(globToRegExp);
  const hit = i.changedPaths
    .filter((p) => !isInOwnNotesDir(p, i.issueNumber))
    .find((p) => globs.some((g) => g.test(p)));
  if (hit !== undefined) {
    inputs.protectedPath = hit;
    return out("hand-off", `protected-path: ${hit} is protected`);
  }

  if (review && review.prNumber !== state.prNumber) {
    return out("hand-off", `review-mismatch: review is for PR #${review.prNumber}, not #${state.prNumber}`);
  }
  // The head may sit past the reviewed commit by the build's own notes only:
  // the reviewer writes its verdict and status into `.lastlight/issue-<N>/`
  // after reviewing, and the `pr` phase updates the status once more. GitHub's
  // `reviewedSha...head` comparison decides whether that is ALL that moved
  // (`notesOnlyAdvance`); then the head counts as reviewed and the executor
  // pins the merge to it.
  let headReviewed = !!review && review.reviewedSha === state.headSha;
  if (review && !headReviewed && i.headComparison && i.headComparison !== "error") {
    const advance = notesOnlyAdvance(i.headComparison, i.issueNumber);
    inputs.notesOnlyAdvance = advance.ok ? true : advance.reason;
    headReviewed = advance.ok;
  }
  if (review && review.reviewedSha === state.headSha && review.verdict === "REQUEST_CHANGES") {
    return out("hand-off", "changes-requested: the build review requested changes on this head");
  }
  if (i.mergeableState === "dirty") return out("hand-off", "conflict: the PR has merge conflicts");
  // The head moved past the reviewed commit (a pr-fix push, a human push).
  // Only a build run records a review, so nothing will ever re-record this
  // head: waiting would be permanent and silent.
  if (review && !headReviewed && i.headComparison === "error") {
    return out("wait", "compare-unknown: the reviewed commit could not be compared with the head");
  }
  if (review && !headReviewed) {
    const why = typeof inputs.notesOnlyAdvance === "string" ? ` (${inputs.notesOnlyAdvance})` : "";
    return out("hand-off", `stale-review: reviewed ${review.reviewedSha}, head is ${state.headSha}${why}`);
  }
  // Only an explicit approval authorises an unattended merge, whatever other
  // verdict a record may carry one day.
  if (review && review.verdict !== "APPROVED") {
    return out("hand-off", `not-approved: the build review verdict is "${String(review.verdict)}"`);
  }

  // 3. Waits.
  if (!review) return out("wait", "no-review: no build review is recorded for this PR");
  if (state.checksState === "pending") return out("wait", "checks-pending: CI has not settled yet");
  const noneOk = cfg.minSettledChecks === 0 && state.checksState === "none";
  if (!noneOk && (state.checksState === "none" || state.settledCheckCount < cfg.minSettledChecks)) {
    return out(
      "wait",
      `no-checks: ${state.settledCheckCount} settled check(s), merge.minSettledChecks is ${cfg.minSettledChecks}`,
    );
  }
  if (state.checksState === "failing") return out("wait", "checks-failing: CI is red; pr-fix owns it");
  switch (i.mergeableState) {
    case "clean":
      break;
    case null:
    case "unknown":
      return out("wait", "mergeable-unknown: GitHub has not computed mergeability yet");
    case "blocked":
      return out("wait", "blocked: branch protection requirements are not yet met");
    case "behind":
      return out("wait", "behind: the head is behind the base branch");
    default:
      return out("wait", `not-clean: mergeable_state is "${i.mergeableState}"`);
  }

  // 4. Merge.
  if (review.reviewedSha !== state.headSha) {
    return out(
      "merge",
      `clean: reviewed ${review.reviewedSha} approved, head ${state.headSha} adds only the build's own notes, checks green, mergeable`,
    );
  }
  return out("merge", `clean: reviewed head ${state.headSha} approved, checks green, mergeable`);
}
