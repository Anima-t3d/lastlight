/**
 * The autonomy stage's merge policy, projected onto one dispatch.
 *
 * Split out of `simple.ts` because two very different callers read it: the
 * runner (to render `{{autonomyMerge.*}}`) and the merge executor
 * (`engine/build-merge.ts`, to decide whether a finished build's PR is the
 * gate's to merge). This module has no runtime imports, so the executor does
 * not pull the runner, the loader and the sandbox in with it.
 */

import type { AutonomyStageConfig } from "../config/config.js";

/** The merge policy a stage can ask for; anything else reads as `none`. */
type AutonomyMerge = AutonomyStageConfig["on_merge"];

/** The shape `{{autonomyMerge.*}}` renders from. See {@link resolveAutonomyMerge}. */
export interface AutonomyMergeContext {
  /** What the operator wrote for this stage — recorded even when it is not acted on. */
  configured: AutonomyMerge;
  /** What this run may actually act on: `auto`, or `none` for everything else. */
  effective: AutonomyMerge;
  /** `effective === "auto"`, as a boolean the prompt's `{{#if}}` arm can test. */
  auto: boolean;
  /** `effective === "gate"`: the autonomous merge gate owns this PR's merge. */
  gate: boolean;
}

/** The inert answer: park the PR, say nothing about merging. */
const NO_AUTONOMY_MERGE: AutonomyMergeContext = {
  configured: "none",
  effective: "none",
  auto: false,
  gate: false,
};

function isAutonomyMerge(raw: unknown): raw is AutonomyMerge {
  return raw === "none" || raw === "auto" || raw === "auto-low-impact" || raw === "gate";
}

/**
 * The stage's merge policy (`autonomy.stages.<stage>.on_merge`), projected onto
 * the run's template context so `prompts/pr.md` can render the one instruction
 * that acts on it.
 *
 * THREE facts travel, not one, because the template engine's `{{#if}}` is a
 * truthiness test with no equality operator (`core/templates.ts`): a bare
 * string could not express "only when this is exactly `auto`". So `auto` is the
 * boolean the prompt's arm tests, `effective` is what the run may act on, and
 * `configured` is what the operator actually wrote.
 *
 * AUTONOMOUS RUNS ONLY — and this is the invariant the whole projection exists
 * to hold. A human's `@bot build` carries no stage, so it projects `none`
 * however `on_merge` is configured: the operator opted a PIPELINE into
 * auto-merge, not every build anyone can ask for on that repo. Read the dispatch
 * markers defensively (they arrive through the untyped `extra`, exactly as
 * `_autonomyGates` does) and treat anything unrecognised as not-autonomous —
 * every unknown here has to fail toward "a human merges it".
 *
 * `gate` is the autonomous merge gate: it is effective only for an autonomous
 * run on a repo that is on BOTH the autonomy list and the Merges list.
 * `mergeListed` is that intersection, computed by the CALLER
 * (`isMergeRepo(r) && isAutonomousRepo(r)`) because the Merges-subset-of-autonomy
 * invariant is enforced at write time only; passing a boolean keeps this pure.
 * Anything else reads as `none`, with `configured` still recording the ask.
 *
 * `auto-low-impact` is ACCEPTED, RECORDED, and behaves exactly as `none`. There
 * is no impact signal for a feature PR today — `dependencies.autoMergeMaxImpact`
 * scores dependency bumps and nothing else — and the honest response to a
 * missing signal is the conservative branch, not a fabricated score. It is kept
 * on `configured` rather than collapsed away so the run row still records the
 * policy the operator asked for, and so the day a real signal exists there is
 * one obvious place to start honouring it.
 */
export function resolveAutonomyMerge(
  extra: Record<string, unknown> | undefined,
  stages: Record<string, AutonomyStageConfig>,
  mergeListed: boolean,
): AutonomyMergeContext {
  const stage = extra?._stage;
  const stageName = typeof stage === "string" && stage.trim() !== "" ? stage : undefined;
  // Either marker answers: `_stage` is what the router stamps today, and
  // `_autonomous` is the flag the dispatch gate sets beside it. Neither present
  // ⇒ a human asked for this build.
  const autonomous = extra?._autonomous === true || stageName !== undefined;
  if (!autonomous) return NO_AUTONOMY_MERGE;

  const raw = stageName === undefined ? undefined : stages[stageName]?.on_merge;
  const configured: AutonomyMerge = isAutonomyMerge(raw) ? raw : "none";
  const effective: AutonomyMerge =
    configured === "auto" ? "auto" : configured === "gate" && mergeListed ? "gate" : "none";
  return { configured, effective, auto: effective === "auto", gate: effective === "gate" };
}
