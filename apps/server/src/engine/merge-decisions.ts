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
 * `merge`    — every condition holds on the reviewed head.
 *
 * Fail closed: the PR merges only when nothing below objects, and
 * `mergeableState` is exactly `"clean"`.
 */

import type { MergeConfig } from "../config/config.js";
import type { BuildReviewRecord } from "./build-review.js";
import type { Decision } from "./pr-decisions.js";
import type { PrState } from "./pr-state.js";

export type BuildMergeDecision = "merge" | "wait" | "hand-off";

export interface BuildMergeInputs {
  state: PrState;
  review: BuildReviewRecord | null;
  /** Changed paths incl. previous names; `null` = completeness unconfirmed. */
  changedPaths: readonly string[] | null;
  prLabels: readonly string[];
  /** `resolveAutonomyMerge(...).gate` */
  mergeEnabled: boolean;
  /** The PR was opened by a build run of this instance. */
  fromBuildRun: boolean;
  /** GitHub's `mergeable_state`, `null` when not yet computed. */
  mergeableState: string | null;
  /** The PR targets the repo's default branch. */
  baseIsDefault: boolean;
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

  // 2. Needs a human.
  const hold = cfg.holdLabels.find((l) => i.prLabels.includes(l));
  if (hold !== undefined) return out("hand-off", `hold-label: PR carries "${hold}"`);

  if (i.changedPaths === null) {
    return out("hand-off", "paths-unknown: the changed-file list could not be confirmed complete");
  }
  const globs = cfg.protectedPaths.map(globToRegExp);
  const hit = i.changedPaths.find((p) => globs.some((g) => g.test(p)));
  if (hit !== undefined) {
    inputs.protectedPath = hit;
    return out("hand-off", `protected-path: ${hit} is protected`);
  }

  if (review && review.prNumber !== state.prNumber) {
    return out("hand-off", `review-mismatch: review is for PR #${review.prNumber}, not #${state.prNumber}`);
  }
  if (review && review.reviewedSha === state.headSha && review.verdict === "REQUEST_CHANGES") {
    return out("hand-off", "changes-requested: the build review requested changes on this head");
  }
  if (i.mergeableState === "dirty") return out("hand-off", "conflict: the PR has merge conflicts");

  // 3. Waits.
  if (!review) return out("wait", "no-review: no build review is recorded for this PR");
  if (review.reviewedSha !== state.headSha) {
    return out("wait", `stale-review: reviewed ${review.reviewedSha}, head is ${state.headSha}`);
  }
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
  return out("merge", `clean: reviewed head ${state.headSha} approved, checks green, mergeable`);
}
