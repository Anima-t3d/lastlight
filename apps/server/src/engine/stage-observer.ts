/**
 * The TERMINAL half of the software-factory stage pipeline — the second and
 * final call site of `./stage-advance.ts`.
 *
 * The dispatch-time advance (`./build-gate.ts`, guard 2) moves an issue onto
 * the stage's `running` label before the run starts. Nothing moved it off
 * again: without this module `agent-building` is a dead end, and every issue
 * the pipeline ever picked up sits there forever while the run that owns it
 * has long since finished. This closes that loop.
 *
 * ```
 * agent-building ──▶ ready-for-human   (succeeded)
 *                └──▶ agent-blocked     (failed | cancelled)
 * ```
 *
 * ## Why an observer, and not a line in `simple.ts`
 *
 * The precedent is exact, and it is `./review-check.ts`: the `last-light/review`
 * check used to be completed from a `.then()` chained onto the in-memory
 * workflow promise, so it stranded on every deploy, every resume, every TTL
 * expiry and every crash. The fix was not routing but DURABILITY — make the
 * projection follow the run's PERSISTED terminal transition, wherever that
 * transition happens. Hanging off `TerminalRunObserver` is what makes
 * `simple.ts`, `resume.ts`, the queued-run TTL expiry and the admin cancel all
 * move the label for free, and what stops a ninth terminal path being added
 * without one. A stage label stranded at `agent-building` is the same class of
 * bug as a check stranded at `in_progress`, with a worse symptom: it is the
 * source of truth for where an issue has got to, so a human scanning the
 * tracker reads a lie.
 *
 * ## The observer contract
 *
 * `workflow-run-store.ts` states it: **synchronous, never throws, never
 * re-enters the store.** Everything here is one cheap synchronous filter and
 * then a fire-and-forget of the GitHub work, the same shape
 * `installReviewCheckObserver` uses — the promise carries a `.catch`, which is
 * both how the rejection gets somewhere to go and how it satisfies the
 * `lint-floating-promises` gate.
 *
 * ## Idempotency, without bookkeeping
 *
 * The observer can fire more than once for one run — a restart-resumed run that
 * finishes twice, a retry, a cancel racing a finish. It needs no dedup state,
 * because `advanceStage` is naturally idempotent at both ends: re-adding a label
 * the issue already carries is a no-op for GitHub's `addLabels`, and
 * `GitHubClient.removeLabel` swallows the 404 that means "already gone" (see
 * `github.ts` — the one status that means "already in the desired state"). So a
 * second firing re-asserts the same two facts and changes nothing. Recording a
 * "already advanced" flag would buy nothing and add a write that could itself
 * fail or go stale; the durable fact is the run row, and the label is its
 * projection.
 */

import { advanceStage } from "./stage-advance.js";
import {
  getAutonomyConfig,
  getBotName,
  getBuildConfig,
  stageWorkflow,
  type AutonomyStageConfig,
} from "../config/config.js";
import { classifyBuildFailure, resolveBuildEscalation } from "./build-decisions.js";
import { currentUsage } from "./usage-runtime.js";
import { logger } from "../logging/logger.js";
import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import type { GitHubClient } from "./github/github.js";

const log = logger("stage-observer");

export interface StageObserverDeps {
  /** `null` in chat-only mode — there is then no label to advance. */
  github: GitHubClient | null;
  /**
   * Called with the qualified `owner/repo` after a label actually moved.
   *
   * INJECTED rather than imported, so the engine keeps no edge to a delivery
   * surface: the one caller hands in `invalidateBoard` from the admin board
   * cache. Without it the board reads a stale label for up to its whole TTL,
   * and the result is a card that contradicts itself — the run band says
   * FAILED (read live from the database) while the card still sits in the
   * "building" column (read from the cached GitHub answer). Two freshness
   * windows on one card is worse than either being slow.
   *
   * Fires only on a CLEAN advance. A degraded one returns early above, and
   * busting the cache to re-read a label we know is half-written would just
   * spend a GitHub request to show the same wrong thing.
   */
  onAdvanced?: (repo: string) => void;
  /**
   * L3 escalation: dispatch a retry of a failed autonomous build through the
   * `dispatchWorkflow` choke point (which runs the build gate on route
   * `escalation`). Resolves `"dispatched"` once a run exists for it, and
   * `"skipped"` when the gate (or any choke-point guard) refused it.
   *
   * INJECTED for the same reason as {@link onAdvanced}. Absent = no escalation:
   * every failure lands on `on_failure`, exactly as before.
   */
  dispatchEscalation?: (
    workflow: string,
    context: Record<string, unknown>,
  ) => Promise<"dispatched" | "skipped">;
}

/**
 * The stage name this run was dispatched under, or `null` if it was not a
 * stage dispatch at all.
 *
 * Read BY NAME off the stored `context`, never through a mirrored type — the
 * same rule `PrStatePanel` follows. That JSON was written by whatever build was
 * running when the run started and is read back here by whatever build is
 * running when it ends, which for a paused-then-resumed run can be a different
 * release. A type assertion would claim a guarantee the storage cannot make.
 *
 * Two keys, because two things are being asked and only one of them exists on
 * every dispatch today: `_stage` is what the router stamps (`router.ts`, the
 * `issue.labeled` case) and is the one that NAMES the stage, so a run without it
 * cannot be advanced whatever else it carries. `_autonomous` is the gate's own
 * "this dispatch is autonomous" flag; where it is present and explicitly
 * `false`, that is a deliberate statement and it wins. An `@bot build` comment
 * carries neither, which is the case that matters most: a human-asked build
 * must never acquire stage labels it did not enter the pipeline through.
 */
function readStageName(run: WorkflowRun): string | null {
  const ctx = run.context ?? {};
  if (ctx._autonomous === false) return null;
  const stage = ctx._stage;
  if (typeof stage !== "string" || !stage) return null;
  return stage;
}

/**
 * Which label a terminal status lands on.
 *
 * Every terminal status of `workflow_runs` is named explicitly rather than
 * being swept up by an `else`, so adding a fourth one is a type error here
 * instead of a silent mis-labelling. The three are the store's own union
 * (`succeeded | failed | cancelled`).
 *
 * `cancelled` maps to `on_failure` with `failed`: from the issue's point of
 * view they are the same fact — the build did not get there and a person needs
 * to look. `agent-blocked` is the label that says so, and leaving a cancelled
 * run on `agent-building` would strand it exactly as before.
 *
 * **`paused` is NOT terminal and never reaches this function** — the store only
 * ever notifies for the three above. That is load-bearing rather than
 * incidental: a run sitting on an approval gate is `paused`, and the whole
 * point of an HITL gate is that the work is still in flight while a human
 * decides. Moving the label there would report a build as finished mid-run,
 * and — because the resume path finishes the run later — move it a second time.
 * This is the easy mistake in this module; the type is what prevents it.
 */
function targetLabel(
  stage: AutonomyStageConfig,
  status: "succeeded" | "failed" | "cancelled",
): string {
  switch (status) {
    case "succeeded":
      return stage.on_success;
    case "failed":
      return stage.on_failure;
    case "cancelled":
      return stage.on_failure;
  }
}

/**
 * Where this run happened. The `owner` / `repo` / `issueNumber` COLUMNS are
 * preferred and are populated for a build run — `createRun` writes them from
 * the normalized repo ref and the dispatch context's issue number.
 *
 * `triggerId` (`owner/repo#N`) is the fallback, not the primary, because it is
 * a formatted string and the columns are the structured fact. It earns its
 * place anyway: it is the value the run is KEYED on, so it is the one field
 * that cannot be absent.
 */
function locate(run: WorkflowRun): { owner: string; repo: string; issueNumber: number } | null {
  if (run.owner && run.repo && typeof run.issueNumber === "number" && run.issueNumber > 0) {
    return { owner: run.owner, repo: run.repo, issueNumber: run.issueNumber };
  }
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(run.triggerId ?? "");
  if (!match) return null;
  return { owner: match[1], repo: match[2], issueNumber: Number(match[3]) };
}

/** The async half — everything the synchronous observer fires and forgets. */
async function advanceTerminalStage(
  run: WorkflowRun,
  status: "succeeded" | "failed" | "cancelled",
  stageName: string,
  deps: StageObserverDeps,
): Promise<void> {
  // An operator renamed or removed the stage between dispatch and completion,
  // or the run predates the stage. There is no label vocabulary to move within,
  // so there is nothing correct to do — and nothing alarming either, which is
  // why this is debug rather than warn.
  const stage = getAutonomyConfig().stages[stageName];
  if (!stage) {
    log.debug("Terminal stage run names a stage that is not configured; leaving its label alone", {
      runId: run.id,
      workflow: run.workflowName,
      stage: stageName,
      status,
    });
    return;
  }

  const where = locate(run);
  if (!where) {
    log.warn("Terminal stage run has no issue to label", {
      runId: run.id,
      workflow: run.workflowName,
      stage: stageName,
      triggerId: run.triggerId,
      status,
    });
    return;
  }

  const to = targetLabel(stage, status);
  const advance = await advanceStage(
    { ...where, from: stage.running, to },
    { github: deps.github },
  );

  // Same condition `build-gate.ts` warns on, and for the same reason: the label
  // IS the stage, so a half-advance is the projection degrading. `advanced:
  // false` means the issue is still reported as building when it is not;
  // `removed: false` means it now claims both. Neither loses the run — that
  // fact is in the database — but both mislead a human reading the tracker,
  // which is the audience the whole pipeline is for.
  if (!advance.advanced || !advance.removed) {
    log.warn("Terminal stage label advance degraded — the issue's stage now misreports", {
      runId: run.id,
      workflow: run.workflowName,
      stage: stageName,
      status,
      ...where,
      from: stage.running,
      to,
      advanced: advance.advanced,
      removed: advance.removed,
      reason: advance.reason,
    });
    return;
  }

  log.info("Advanced the stage label on a terminal run", {
    runId: run.id,
    workflow: run.workflowName,
    stage: stageName,
    status,
    ...where,
    from: stage.running,
    to,
  });

  // The label moved, so anything caching the OLD one is now wrong. Best-effort
  // and deliberately last: a cache that refuses to clear must not turn a
  // successful advance into a logged failure.
  try {
    deps.onAdvanced?.(`${where.owner}/${where.repo}`);
  } catch (err: unknown) {
    log.debug("Stage advance notification failed", { runId: run.id, err });
  }
}

// ── L3 escalation ──────────────────────────────────────────────────────────

/** The attempt a run was dispatched as (`_attempt` on its context), default 1. */
function readAttempt(run: WorkflowRun): number {
  const raw = run.context?._attempt;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/**
 * Is this failed run one the escalation decides? Only an AUTONOMOUS stage run
 * (`readStageName` already said so) of a stage whose workflow is `build`, and
 * only when an escalation port is wired. Synchronous: one config lookup.
 */
function escalates(run: WorkflowRun, stageName: string, deps: StageObserverDeps): boolean {
  if (!deps.dispatchEscalation) return false;
  const stage = getAutonomyConfig().stages[stageName];
  return !!stage && stageWorkflow(stage) === "build" && run.workflowName === "build";
}

/**
 * The once-per-run claim. The observer fires once per `finishRun`, and a failed
 * run is finished up to three times (the phase executor, the scheduler and
 * `simple.ts` each call it), so the FIRST firing decides and the rest return.
 * In-process and synchronous, which is what makes it race-free: the claim is
 * taken before any await. The gate's (triggerId, attempt) key is the durable
 * half (`build-gate.ts`). Entries age out after an hour; a run does not re-fail.
 */
const CLAIM_TTL_MS = 60 * 60_000;
const claimsByDb = new WeakMap<StateDb, Map<string, number>>();

function claimFailure(db: StateDb, runId: string): boolean {
  let claims = claimsByDb.get(db);
  if (!claims) {
    claims = new Map();
    claimsByDb.set(db, claims);
  }
  const now = Date.now();
  for (const [id, at] of claims) if (now - at > CLAIM_TTL_MS) claims.delete(id);
  if (claims.has(runId)) return false;
  claims.set(runId, now);
  return true;
}

/**
 * The hold comment. Fixed text: it is posted once per failed run, and the
 * usage gate itself never comments on an issue (`noteUsageHold` records an
 * activity row and a webhook only), so this is the one place a human hears it.
 */
export function renderEscalationHoldComment(botName: string): string {
  return (
    "This build failed, and I'm not retrying it automatically: either the model provider " +
    "refused the account (quota, billing or sign-in), or the usage limits are close, so a " +
    "retry now would most likely fail the same way.\n\n" +
    `Once that has cleared, comment \`@${botName} retry\` (optionally followed by a hint) to run it again.`
  );
}

/**
 * Best-effort: record what this attempt cost on the run's scratch, as
 * `attemptCost: { attempt, costUsd }` — the same sum the run panel shows (the
 * run's ledger rows). Never throws.
 */
async function recordAttemptCost(
  db: StateDb,
  run: WorkflowRun,
  rows: ReadonlyArray<{ costUsd?: number }>,
): Promise<void> {
  try {
    const costUsd = rows.reduce((sum, r) => sum + (typeof r.costUsd === "number" ? r.costUsd : 0), 0);
    await db.runs.mergeScratch(run.id, { attemptCost: { attempt: readAttempt(run), costUsd } });
  } catch (err: unknown) {
    log.debug("Could not record the attempt's cost", { runId: run.id, err });
  }
}

/** What {@link planEscalation} decided to do with a failed build. */
type EscalationPlan =
  | { kind: "hand-off" }
  | { kind: "hold"; where: NonNullable<ReturnType<typeof locate>> }
  | { kind: "retry"; workflow: string; context: Record<string, unknown> };

/**
 * A failed autonomous build: classify it from the persisted rows, ask
 * {@link resolveBuildEscalation}, and act. `retry` keeps the issue on
 * `running` and dispatches attempt n+1; a refused dispatch, a `hold` and a
 * `hand-off` all land on `on_failure` exactly as before (a `hold` also
 * comments once).
 *
 * Everything up to the dispatch is planned inside one try: a ledger read, a
 * usage read, a GitHub read or a config lookup that throws must NOT leave the
 * issue on `running` — no live run remains to move it and the sweep never
 * picks a `running` issue up again. Any failure there is a hand-off.
 */
async function escalateFailedBuild(
  db: StateDb,
  run: WorkflowRun,
  stageName: string,
  deps: StageObserverDeps,
): Promise<void> {
  let plan: EscalationPlan;
  try {
    plan = await planEscalation(db, run, stageName, deps);
  } catch (err: unknown) {
    log.warn("Could not decide a build escalation — handing off", { runId: run.id, err });
    plan = { kind: "hand-off" };
  }

  if (plan.kind === "hand-off") return advanceTerminalStage(run, "failed", stageName, deps);

  if (plan.kind === "hold") {
    await advanceTerminalStage(run, "failed", stageName, deps);
    if (!deps.github) return;
    const { where } = plan;
    try {
      await deps.github.postComment(where.owner, where.repo, where.issueNumber, renderEscalationHoldComment(getBotName()));
    } catch (err: unknown) {
      log.warn("Escalation hold comment failed", { runId: run.id, err });
    }
    return;
  }

  let outcome: "dispatched" | "skipped" = "skipped";
  try {
    outcome = await deps.dispatchEscalation!(plan.workflow, plan.context);
  } catch (err: unknown) {
    log.warn("Escalation dispatch threw — handing off", { runId: run.id, err });
  }
  // A refused retry must not strand the issue on `running`.
  if (outcome === "skipped") return advanceTerminalStage(run, "failed", stageName, deps);
}

/** The read-and-decide half of {@link escalateFailedBuild}. May throw; the caller hands off. */
async function planEscalation(
  db: StateDb,
  run: WorkflowRun,
  stageName: string,
  deps: StageObserverDeps,
): Promise<EscalationPlan> {
  const where = locate(run);
  if (!where) return { kind: "hand-off" };

  const rows = await db.executions.getExecutionsForWorkflowRun(run.id, run.triggerId, run.workflowName);
  await recordAttemptCost(db, run, rows);

  const failure = classifyBuildFailure({
    status: "failed",
    error: typeof run.context?.error === "string" ? run.context.error : undefined,
    phases: rows.map((r) => ({ phase: r.skill, success: r.success, error: r.error, stopReason: r.stopReason })),
  });
  const usage = await currentUsage(db).then(
    (u) => u.verdict,
    () => null,
  );
  const attempt = readAttempt(run);
  const decision = resolveBuildEscalation(
    { failure, attempt, usageAllows: usage?.held !== true },
    { maxAttempts: getBuildConfig().maxAttempts },
  );
  log.info("Build escalation decision", {
    runId: run.id,
    ...where,
    failure,
    attempt,
    decision: decision.decision,
    reason: decision.reason,
  });

  if (decision.decision === "hand-off") return { kind: "hand-off" };
  if (decision.decision === "hold") return { kind: "hold", where };

  // RETRY. The issue's current title, body and labels come from GitHub: the
  // gate's hold check must read the labels as they are NOW, and the run row
  // does not keep the title. A read that fails hands off — toward a human.
  type IssueRead = { title?: string; body?: string | null; state?: string; labels?: unknown[] };
  let issue: IssueRead | null = null;
  if (deps.github) {
    try {
      issue = (await deps.github.getIssue(where.owner, where.repo, where.issueNumber)) as IssueRead;
    } catch (err: unknown) {
      log.warn("Could not read the issue for an escalation retry — handing off", { runId: run.id, err });
      return { kind: "hand-off" };
    }
    if (issue?.state === "closed") return { kind: "hand-off" };
  }
  const labels = (issue?.labels ?? [])
    .map((l: unknown) => (typeof l === "string" ? l : (l as { name?: unknown } | null)?.name))
    .filter((l): l is string => typeof l === "string" && l.length > 0);
  const stage = getAutonomyConfig().stages[stageName];
  if (!stage) return { kind: "hand-off" };
  const ctx = run.context ?? {};
  const context: Record<string, unknown> = {
    repo: `${where.owner}/${where.repo}`,
    issueNumber: where.issueNumber,
    title: issue?.title ?? "",
    body: issue?.body ?? "",
    labels,
    sender: run.triggeredBy ?? getBotName(),
    // Nobody asked for this attempt: the pipeline retried itself.
    triggerActorType: "system",
    _stage: stageName,
    _attempt: attempt + 1,
    _buildRoute: "escalation",
    _senderIsBot: true,
    _escalatedFrom: run.id,
    ...(typeof ctx._addedLabel === "string" ? { _addedLabel: ctx._addedLabel } : {}),
    ...(typeof ctx._hint === "string" && ctx._hint ? { _hint: ctx._hint } : {}),
  };
  return { kind: "retry", workflow: stageWorkflow(stage), context };
}

/**
 * Wire {@link advanceTerminalStage} onto every terminal run transition. Called
 * once, at boot, beside `installReviewCheckObserver`.
 */
export function installStageObserver(db: StateDb, deps: StageObserverDeps): void {
  db.runs.addTerminalObserver((run, status) => {
    const stageName = readStageName(run);
    if (!stageName) return;
    // The observer contract's "never throws" end of the bargain. The run is
    // already persisted as terminal; no projection of it may undo that, and
    // one failing must not cost the other observers their notification.
    const onError = (err: unknown) =>
      log.warn("Terminal stage advance failed for run", { runId: run.id, stage: stageName, err });
    if (status === "failed" && escalates(run, stageName, deps)) {
      // First firing decides; the repeats of the same failure return here.
      if (!claimFailure(db, run.id)) return;
      escalateFailedBuild(db, run, stageName, deps).catch(onError);
      return;
    }
    advanceTerminalStage(run, status, stageName, deps).catch(onError);
    if (deps.dispatchEscalation && run.workflowName === "build") {
      db.executions
        .getExecutionsForWorkflowRun(run.id, run.triggerId, run.workflowName)
        .then((rows) => recordAttemptCost(db, run, rows))
        .catch(onError);
    }
  });
}

/**
 * The {@link StageObserverDeps.dispatchEscalation} port over `dispatchWorkflow`.
 *
 * `dispatchWorkflow` resolves only when the run ENDS, which for a build is
 * hours; the observer needs to know only whether a run exists. So this settles
 * `"dispatched"` the moment `onRunStart` fires (or the run was queued, or a
 * live run already owns the trigger), and `"skipped"` when the dispatch
 * returned without either — the gate's skip, or a choke-point refusal.
 */
export function escalationDispatchPort(
  dispatch: (
    workflow: string,
    context: Record<string, unknown>,
    onRunStart?: (runId: string) => Promise<void>,
  ) => Promise<{ success: boolean; queued?: boolean; paused?: boolean }>,
): NonNullable<StageObserverDeps["dispatchEscalation"]> {
  return (workflow, context) =>
    new Promise((resolve) => {
      let started = false;
      dispatch(workflow, context, async () => {
        started = true;
        resolve("dispatched");
      })
        .then((r) => resolve(started || r.queued || r.paused ? "dispatched" : "skipped"))
        .catch((err: unknown) => {
          log.warn("Escalation run threw", { workflow, err });
          resolve(started ? "dispatched" : "skipped");
        });
    });
}
