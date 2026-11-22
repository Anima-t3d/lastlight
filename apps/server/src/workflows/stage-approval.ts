/**
 * The approval map an autonomous stage run executes under, computed ONE way for
 * every route into the runner: the direct start (`runSimpleWorkflow`), the
 * admission promotion of a run queued at the concurrency cap and the boot /
 * retry resume (`resumeSimpleRun`), and the re-dispatch after a human answers a
 * gate (`runSimpleWorkflow` reusing the paused run).
 *
 *   effective = operator approval ⊕ repo-layer approval ⊕ stage gates
 *
 * where the stage gates are the build stage's `gates` (stamped on the dispatch
 * as `_autonomyGates` by the build gate) unless the repo is on the per-repo
 * Approvals skip list (`approval-skip-repos`) — for autonomous stage runs only.
 * A human `@bot build` carries no `_autonomyGates`, so it gets the base map.
 *
 * **The skip list is read once, when the run is created**, and the resulting
 * stage gates are persisted on the run's context under {@link STAGE_GATES_KEY}.
 * Every later start reads that persisted decision back, so a run keeps the
 * policy it was created under: toggling Approvals while a run is queued or
 * paused changes the next run, not this one. Only the STAGE half is pinned —
 * the base map (operator ⊕ repo layer) is resolved by each path exactly as it
 * was before, so an operator gate raised since still binds a resumed run.
 *
 * Before this module the stage half was computed only in `runSimpleWorkflow`
 * from the CURRENT dispatch's context, so admission (which enters through
 * `resumeSimpleRun`) and the approval re-dispatch (whose context is fresh and
 * carries no `_autonomyGates`) both ran a stage build on the base map alone.
 */
import { isApprovalSkipRepo, isAutonomousRepo } from "../config/config.js";
import type { ApprovalGateConfig } from "./runner.js";

/**
 * The run-context key holding the stage gates decided at creation (after the
 * skip check). `{}` when the repo was skip-listed; absent on a run that was not
 * an autonomous stage dispatch, and on rows written before this key existed.
 */
export const STAGE_GATES_KEY = "_stageGates";

/**
 * The `true` leaves of an untyped gate map, and only those.
 *
 * The union below is **positive-enable only**: the runner's `gateEnabled` tests
 * `=== true`, so a `true` leaf can RAISE a gate the operator left off, but a
 * `false` leaf spread over an operator's `true` would CLEAR it — exactly what
 * the add-only rule forbids. Dropping `false` IS the clamp.
 */
export function enabledGatesFrom(raw: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === true) out[name] = true;
  }
  return out;
}

/** The creation-time stage-gate decision for a new run. */
export interface StageGateDecision {
  /** The gates this run adds onto its base map — `{}` when skipped or not a stage run. */
  gates: Record<string, true>;
  /** The stage gates the skip list dropped (for the log line); empty otherwise. */
  skipped: string[];
  /** Whether the dispatch carried stage gates at all, i.e. whether to persist the decision. */
  isStageRun: boolean;
}

/**
 * Decide the stage gates for a run being CREATED: the dispatch's
 * `_autonomyGates`, dropped entirely when `repo` ("owner/name") is on the
 * Approvals skip list. Like the merge list, a skip entry counts only while the
 * repo is on the autonomy list.
 */
export function decideStageGates(
  extra: Record<string, unknown> | undefined,
  repo: string,
): StageGateDecision {
  const isStageRun = !!extra && extra._autonomyGates !== undefined;
  const stageGates = enabledGatesFrom(extra?._autonomyGates);
  const skip = isApprovalSkipRepo(repo) && isAutonomousRepo(repo);
  return skip
    ? { gates: {}, skipped: Object.keys(stageGates), isStageRun }
    : { gates: stageGates, skipped: [], isStageRun };
}

/**
 * The stage gates of a run that ALREADY EXISTS, read from its stored context:
 * the persisted creation-time decision when present. A row written before the
 * decision was persisted falls back to deciding from its stored
 * `_autonomyGates` now — the best answer such a row allows.
 */
export function storedStageGates(stored: Record<string, unknown>, repo: string): Record<string, true> {
  if (STAGE_GATES_KEY in stored) return enabledGatesFrom(stored[STAGE_GATES_KEY]);
  return decideStageGates(stored, repo).gates;
}

/**
 * Union the stage gates onto the run's base (operator ⊕ repo layer) map. No
 * gates ⇒ the base map by identity, so a run that crossed no stage behaves
 * exactly as it did before the stage gates existed.
 */
export function withStageGates(
  base: ApprovalGateConfig | undefined,
  stageGates: Record<string, true>,
): ApprovalGateConfig | undefined {
  return Object.keys(stageGates).length > 0 ? { ...base, ...stageGates } : base;
}

/**
 * The repo layer to hand the runner alongside an effective approval map.
 *
 * The runner resolves `repoConfig?.approval ?? approvalConfig`, so with a repo
 * layer present the map passed as `approvalConfig` is IGNORED and the layer's
 * own (operator ⊕ repo) map wins — silently dropping the stage gates. Carrying
 * the effective map on the layer keeps both arguments saying the same thing.
 */
export function withRunApproval<T extends { approval: ApprovalGateConfig }>(
  repoConfig: T | undefined,
  approval: ApprovalGateConfig | undefined,
): T | undefined {
  if (!repoConfig || !approval || repoConfig.approval === approval) return repoConfig;
  return { ...repoConfig, approval };
}
