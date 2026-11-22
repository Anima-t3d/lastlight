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
 * as `_autonomyGates` by the build gate) — for autonomous stage runs only. A
 * human `@bot build` carries no `_stage` / `_autonomyGates`, so it gets the
 * base map untouched.
 *
 * When the repo is on the per-repo Approvals skip list (`approval-skip-repos`)
 * the stage gates are not merely left out: every gate NAME the stage declares
 * (the keys of its `gates`, e.g. post_architect and post_reviewer) is turned
 * OFF in the effective map, whichever layer turned it on — the operator's
 * `approval:`, `APPROVAL_GATES`, or the repo layer. An operator who gates every
 * build (vps-sg sets `APPROVAL_GATES=post_architect,post_reviewer`) would
 * otherwise make the toggle a no-op. Any other gate name stays as the base map
 * says.
 *
 * **The skip list is read once, when the run is created**, and the resulting
 * stage gates are persisted on the run's context under {@link STAGE_GATES_KEY}.
 * Every later start reads that persisted decision back, so a run keeps the
 * policy it was created under: toggling Approvals while a run is queued or
 * paused changes the next run, not this one. Only the STAGE half is pinned —
 * the base map (operator ⊕ repo layer) is resolved by each path exactly as it
 * was before, so an operator gate raised since still binds a resumed run — but
 * the stage half is always spread LAST, so a resume can never re-merge the
 * operator's map back over a skip-listed run's `false` leaves.
 *
 * The stage's merge policy (`autonomyMerge`, see `autonomy-merge.ts`) is the
 * same kind of per-dispatch fact with the same failure on a later start, and is
 * pinned the same way: decided at creation, persisted on the context, read back
 * by every later start.
 *
 * Before this module the stage half was computed only in `runSimpleWorkflow`
 * from the CURRENT dispatch's context, so admission (which enters through
 * `resumeSimpleRun`) and the approval re-dispatch (whose context is fresh and
 * carries no `_autonomyGates`) both ran a stage build on the base map alone.
 */
import { getAutonomyConfig, isApprovalSkipRepo, isAutonomousRepo, isMergeRepo } from "../config/config.js";
import { parseAutonomyMerge, resolveAutonomyMerge, type AutonomyMergeContext } from "./autonomy-merge.js";
import type { ApprovalGateConfig } from "./runner.js";

/**
 * The run-context key holding the stage-gate leaves decided at creation (after
 * the skip check): `true` leaves raise a gate, `false` leaves (skip-listed repo
 * only) force one off. Absent on a run that was not an autonomous stage
 * dispatch, and on rows written before this key existed.
 */
export const STAGE_GATES_KEY = "_stageGates";

/**
 * The `true` leaves of an untyped gate map, and only those.
 *
 * For a repo that is NOT skip-listed the union is **positive-enable only**: the
 * runner's `gateEnabled` tests `=== true`, so a `true` leaf can RAISE a gate the
 * operator left off, but a stray `false` in the stage's own map must not clear
 * an operator's gate. Dropping `false` IS that clamp. The only `false` leaves
 * this module ever writes are the skip list's, deliberately.
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
  /** The leaves spread over the base map — `{}` when not a stage run. */
  gates: Record<string, boolean>;
  /** The gate names the skip list turned off (for the log line); empty otherwise. */
  skipped: string[];
  /** Whether this is an autonomous stage dispatch, i.e. whether to persist the decision. */
  isStageRun: boolean;
}

function stageName(extra: Record<string, unknown> | undefined): string | undefined {
  const stage = extra?._stage;
  return typeof stage === "string" && stage.trim() !== "" ? stage : undefined;
}

function isPlainMap(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * Decide the stage gates for a run being CREATED.
 *
 * Not skip-listed: the `true` leaves of the dispatch's `_autonomyGates`.
 * Skip-listed (and on the autonomy list, like the merge list): every gate name
 * the stage declares, set `false`. The names are the keys of `_autonomyGates`
 * — the stage's `gates` map as the build gate stamped it — or, for a stage
 * dispatch that carried none, of the stage's configured `gates`.
 */
export function decideStageGates(
  extra: Record<string, unknown> | undefined,
  repo: string,
): StageGateDecision {
  const stage = stageName(extra);
  const isStageRun = stage !== undefined || extra?._autonomyGates !== undefined;
  if (!isStageRun) return { gates: {}, skipped: [], isStageRun };

  const skip = isApprovalSkipRepo(repo) && isAutonomousRepo(repo);
  if (!skip) return { gates: enabledGatesFrom(extra?._autonomyGates), skipped: [], isStageRun };

  const declared = isPlainMap(extra?._autonomyGates)
    ? extra._autonomyGates
    : stage !== undefined
      ? getAutonomyConfig().stages[stage]?.gates
      : undefined;
  const names = isPlainMap(declared) ? Object.keys(declared) : [];
  return { gates: Object.fromEntries(names.map((n) => [n, false])), skipped: names, isStageRun };
}

/**
 * The stage gates of a run that ALREADY EXISTS, read from its stored context:
 * the persisted creation-time decision when present (boolean leaves only — it
 * is this module's own output). A row written before the decision was
 * persisted falls back to deciding from its stored markers now — the best
 * answer such a row allows.
 */
export function storedStageGates(stored: Record<string, unknown>, repo: string): Record<string, boolean> {
  const persisted = stored[STAGE_GATES_KEY];
  if (isPlainMap(persisted)) {
    const out: Record<string, boolean> = {};
    for (const [name, value] of Object.entries(persisted)) if (typeof value === "boolean") out[name] = value;
    return out;
  }
  return decideStageGates(stored, repo).gates;
}

/**
 * The stage's merge policy for a run being CREATED, from the dispatch markers
 * and the CURRENT Merges and autonomy lists. Persisted on the run context
 * under `autonomyMerge` — the same key the template context reads.
 */
export function decideAutonomyMerge(
  extra: Record<string, unknown> | undefined,
  repo: string,
): AutonomyMergeContext {
  return resolveAutonomyMerge(extra, getAutonomyConfig().stages, isMergeRepo(repo) && isAutonomousRepo(repo));
}

/**
 * The merge policy of a run that ALREADY EXISTS: the persisted creation-time
 * value when well-formed, else resolved from the row's stored dispatch markers
 * (a row written before the value was persisted, or a human build, which
 * resolves to the inert policy).
 */
export function storedAutonomyMerge(stored: Record<string, unknown>, repo: string): AutonomyMergeContext {
  return parseAutonomyMerge(stored.autonomyMerge) ?? decideAutonomyMerge(stored, repo);
}

/**
 * Spread the stage leaves over the run's base (operator ⊕ repo layer) map —
 * LAST, so they win: a `true` raises a gate, a skip-list `false` clears it. No
 * leaves ⇒ the base map by identity, so a run that crossed no stage behaves
 * exactly as it did before the stage gates existed.
 */
export function withStageGates(
  base: ApprovalGateConfig | undefined,
  stageGates: Record<string, boolean>,
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
