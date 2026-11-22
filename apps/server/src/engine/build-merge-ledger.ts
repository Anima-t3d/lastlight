/**
 * The merge gate's per-run decision ledger, in a module with no runtime
 * imports: `build-review.ts` (which the runner loads) writes a hand-off entry
 * when a gate run's approval cannot be recorded, and must not statically load
 * `build-merge.ts`, which reaches the PR state machine and the sandbox modules.
 *
 * The ledger is also the comment dedupe: a hand-off comment is posted at most
 * once per (reason case, head), checked against the entries marked `commented`.
 */

import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import type { MergeTrigger } from "./build-merge-route.js";
import type { BuildMergeDecision } from "./merge-decisions.js";

export type MergeOutcome = "merged" | "head-moved" | "already-merged" | "not-mergeable";

/** `workflow_runs.scratch` key holding the build run's merge-decision ledger. */
export const MERGE_DECISIONS_SCRATCH_KEY = "mergeDecisions";

/** How many ledger entries a build run keeps. */
export const MERGE_DECISIONS_MAX = 50;

export interface MergeDecisionEntry {
  at: string;
  trigger: MergeTrigger;
  decision: BuildMergeDecision;
  reason: string;
  headSha: string;
  outcome?: MergeOutcome;
  /** Set (true) only when this evaluation posted a PR comment. */
  commented?: boolean;
}

/** The reason's case: the text before the first `:`. */
export function reasonCase(reason: string): string {
  const i = reason.indexOf(":");
  return i === -1 ? reason : reason.slice(0, i);
}

export function priorEntries(run: WorkflowRun): MergeDecisionEntry[] {
  const raw = (run.scratch ?? {})[MERGE_DECISIONS_SCRATCH_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is MergeDecisionEntry =>
      !!e && typeof e === "object" && typeof e.reason === "string" && typeof e.decision === "string",
  );
}

/** A hand-off comment for `reason`'s case was already posted at `headSha`. */
export function hasCommented(run: WorkflowRun, headSha: string, reason: string): boolean {
  return priorEntries(run).some(
    (e) =>
      e.decision === "hand-off" &&
      e.headSha === headSha &&
      e.commented === true &&
      reasonCase(e.reason) === reasonCase(reason),
  );
}

/**
 * Append one entry to the run's ledger, keeping the last
 * {@link MERGE_DECISIONS_MAX}. An evaluation that changed nothing (same
 * decision, reason, head and outcome as the last entry, and no comment posted)
 * is not recorded, so the sweep does not fill the ledger with repeats.
 */
export async function appendDecision(
  db: StateDb,
  run: WorkflowRun,
  entry: Omit<MergeDecisionEntry, "at">,
): Promise<void> {
  const prior = priorEntries(run);
  const last = prior[prior.length - 1];
  if (
    last &&
    !entry.commented &&
    last.decision === entry.decision &&
    last.reason === entry.reason &&
    last.headSha === entry.headSha &&
    last.outcome === entry.outcome
  ) {
    return;
  }
  const next = [...prior, { at: new Date().toISOString(), ...entry }].slice(-MERGE_DECISIONS_MAX);
  await db.runs.mergeScratch(run.id, { [MERGE_DECISIONS_SCRATCH_KEY]: next });
  // Keep the in-memory row current for a later step of this same evaluation.
  run.scratch = { ...(run.scratch ?? {}), [MERGE_DECISIONS_SCRATCH_KEY]: next };
}
