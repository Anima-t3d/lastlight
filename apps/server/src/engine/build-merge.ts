/**
 * The autonomous merge executor: evaluate one build PR and, when every
 * condition holds on the reviewed head, squash-merge it.
 *
 * This is the first code that merges a PR unattended, so it fails closed at
 * every step:
 *
 * - The decision is {@link mayMergeBuild}, pure over a snapshot read here. This
 *   module only gathers inputs and acts on the answer.
 * - The merge is pinned to the SHA the build review approved. GitHub refuses it
 *   (`head-moved`) if anything was pushed after the snapshot was read.
 * - A read that throws propagates: no snapshot, no merge. Every trigger catches
 *   and logs, and the 20-minute sweep is the retry.
 * - `fromBuildRun` is true only when a succeeded build run of THIS instance
 *   recorded this PR number in its `buildReview` scratch.
 * - The repo's `.lastlight/` `merge:` layer is refreshed before every decision.
 *   It can only tighten, so a refresh that fails waits rather than deciding on
 *   the operator's policy alone, and so does a `lastlight.yml` that is present
 *   but was not applied (bad YAML, not a mapping, cut by a cap).
 * - The instance hold label stops a merge from the PR or the build's issue.
 *
 * Three triggers call {@link evaluateBuildMerge}: the green-settle webhook
 * (`checks-settled`), the build's own finish hook after an APPROVED record
 * (`build-finished`), and the cron sweep (`sweep`). They can fire together, so
 * evaluations of one PR are serialized by an in-process mutex.
 */

import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import type { GitHubClient } from "./github/github.js";
import type { WebhookEmitter } from "../notify/webhook/emitter.js";
import { buildRunPayload } from "../notify/webhook/payload.js";
import {
  getAutonomyConfig,
  getHoldLabel,
  isAutonomousRepo,
  isMergeRepo,
  mergeConfigForLayer,
} from "../config/config.js";
import { refreshRepoLayer, unappliedRepoConfigFile, type RepoLayer } from "../config/repo-config.js";
import { resolveAutonomyMerge } from "../workflows/autonomy-merge.js";
import { BUILD_WORKFLOW, readBuildReview, type BuildReviewRecord } from "./build-review.js";
import { issueTriggerId } from "./build-decisions.js";
import { mayMergeBuild, type BuildMergeDecision } from "./merge-decisions.js";
import { emptyPrState, type PrState } from "./pr-state.js";
import type { MergeTrigger } from "./build-merge-route.js";
import {
  appendDecision,
  hasCommented,
  priorEntries,
  reasonCase,
  type MergeOutcome,
} from "./build-merge-ledger.js";
import { logger } from "../logging/logger.js";

const log = logger("build-merge");

export { BUILD_MERGE_HANDLER, type MergeTrigger } from "./build-merge-route.js";
export {
  MERGE_DECISIONS_MAX,
  MERGE_DECISIONS_SCRATCH_KEY,
  type MergeDecisionEntry,
  type MergeOutcome,
} from "./build-merge-ledger.js";

export interface BuildMergeDeps {
  github: GitHubClient;
  db: StateDb;
  /** `<botName>[bot]` — the PR author a build PR must have. */
  botLogin: string;
}

export interface BuildMergeResult {
  decision: BuildMergeDecision;
  outcome?: MergeOutcome;
  reason: string;
}

// ── Notifier wiring ──────────────────────────────────────────────────────────

interface BuildMergeRuntime {
  emitter: Pick<WebhookEmitter, "emit"> | null;
  botName: string;
  dashboardBase?: string;
}

let runtime: BuildMergeRuntime = { emitter: null, botName: "last-light" };

/** Wired at boot (`index.ts`): the outgoing-webhook emitter for `run.merged`. */
export function configureBuildMerge(patch: Partial<BuildMergeRuntime>): void {
  runtime = { ...runtime, ...patch };
}

// ── The per-PR mutex ─────────────────────────────────────────────────────────

/** `owner/repo#N` → the tail of that PR's evaluation chain. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Evaluate one PR, and merge it when {@link mayMergeBuild} says `merge`.
 *
 * Serialized per PR: a second call while one is running waits for it and then
 * evaluates afresh, so it sees the first one's merge (a closed PR) rather than
 * merging again. Rejects when a read or the merge call fails in a way that is
 * not a merge decision (auth, rate limit, 5xx); nothing is merged then.
 */
export function evaluateBuildMerge(
  deps: BuildMergeDeps,
  repo: string,
  prNumber: number,
  trigger: MergeTrigger,
): Promise<BuildMergeResult> {
  const key = `${repo}#${prNumber}`;
  const prev = inFlight.get(key) ?? Promise.resolve();
  const next = prev.then(
    () => evaluateOnce(deps, repo, prNumber, trigger),
    () => evaluateOnce(deps, repo, prNumber, trigger),
  );
  inFlight.set(key, next);
  const release = () => {
    if (inFlight.get(key) === next) inFlight.delete(key);
  };
  next.then(release, release);
  return next;
}

// ── One evaluation ───────────────────────────────────────────────────────────

async function evaluateOnce(
  deps: BuildMergeDeps,
  repo: string,
  prNumber: number,
  trigger: MergeTrigger,
): Promise<BuildMergeResult> {
  const [owner, name] = repo.split("/");
  if (!owner || !name || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { decision: "wait", reason: `bad-subject: ${repo}#${prNumber} is not a PR` };
  }

  // Both lists, every time: the Merges toggle is the operator's off switch, and
  // it must stop a merge that an earlier trigger already queued.
  const mergeListed = isMergeRepo(repo) && isAutonomousRepo(repo);
  if (!mergeListed) {
    return { decision: "wait", reason: "merge-disabled: the repo is not on both the Merges and autonomy lists" };
  }

  const { github } = deps;
  const found = await findBuildRun(deps, owner, name, prNumber);
  if (!found) {
    // Silent by design: a PR no build run recorded is not the gate's (a human's
    // `@bot build`, an older run, another tool's PR). No run, so no ledger.
    log.debug("Not a gate build PR", { repo, prNumber, trigger });
    return {
      decision: "wait",
      reason: "not-from-build: no build run of this instance recorded this PR",
    };
  }
  const { run, issueNumber } = found;
  const review = readBuildReview(run);

  const pr = await github.getPullRequest(owner, name, prNumber);
  const headSha = pr.head?.sha ?? "";

  if (pr.state !== "open") {
    const result: BuildMergeResult = {
      decision: "wait",
      reason: `not-open: the PR is ${pr.merged ? "merged" : "closed"}`,
    };
    await appendDecision(deps.db, run, { trigger, ...result, headSha });
    return result;
  }

  // The repo layer, fresh. `getCachedRepoLayer` is memory-only and empty after
  // every restart, and the layer can only tighten: a cold cache is the looser
  // policy. A refresh that fails is not "no layer", so it waits.
  let layer: RepoLayer | undefined;
  try {
    layer = await refreshRepoLayer(repo, { client: github, throwOnFetchError: true });
  } catch (err: unknown) {
    const result: BuildMergeResult = {
      decision: "wait",
      reason: "repo-config-unknown: the repo's .lastlight/ merge policy could not be read",
    };
    log.warn("Not merging: the repo merge policy could not be refreshed", { repo, prNumber, runId: run.id, trigger, err });
    await appendDecision(deps.db, run, { trigger, ...result, headSha });
    return result;
  }
  // A `lastlight.yml` that is there but was dropped whole (bad YAML, not a
  // mapping, over a cap) may have meant to tighten `merge:`. Deciding on the
  // operator policy alone would be the looser answer, so wait for a fix.
  const unapplied = unappliedRepoConfigFile(layer);
  if (unapplied) {
    const result: BuildMergeResult = {
      decision: "wait",
      reason: `repo-config-unknown: the repo's .lastlight/lastlight.yml was not applied (${unapplied.code})`,
    };
    log.warn("Not merging: the repo's lastlight.yml is present but was not applied", {
      repo,
      prNumber,
      runId: run.id,
      trigger,
      code: unapplied.code,
      message: unapplied.message,
    });
    await appendDecision(deps.db, run, { trigger, ...result, headSha });
    return result;
  }

  const [checks, changedPaths, defaultBranch, issue] = await Promise.all([
    headSha
      ? github.getChecksSummary(owner, name, headSha, { excludeApp: appSlug(deps.botLogin), strict: true })
      : Promise.resolve(null),
    github.listAllPullRequestFilePaths(owner, name, prNumber),
    github.getDefaultBranch(owner, name),
    // Live: a hold label put on the issue after the build must still stop the merge.
    github.getIssue(owner, name, issueNumber),
  ]);

  const state = snapshot(repo, prNumber, pr, deps.botLogin, checks);
  const mergeEnabled = resolveAutonomyMerge(run.context, getAutonomyConfig().stages, mergeListed).gate;
  const decided = mayMergeBuild(
    {
      state,
      review,
      changedPaths,
      prLabels: state.labels,
      issueLabels: labelNames(issue?.labels),
      holdLabel: getHoldLabel(),
      mergeEnabled,
      fromBuildRun: true,
      mergeableState: typeof pr.mergeable_state === "string" ? pr.mergeable_state : null,
      baseIsDefault: !!defaultBranch && pr.base?.ref === defaultBranch,
    },
    mergeConfigForLayer(layer),
  );
  const { decision, reason } = decided;
  const ctx = { repo, prNumber, runId: run.id, trigger, decision, reason };

  /**
   * Hand the PR to a human: one comment per (reason case, head), deduped
   * against the ledger's `commented` entries, then one ledger entry. `body`
   * null hands off without a comment.
   */
  const handOff = async (
    handReason: string,
    body: string | null,
    outcome?: MergeOutcome,
  ): Promise<BuildMergeResult> => {
    const already = hasCommented(run, headSha, handReason);
    const commented =
      already || body === null ? false : await comment(github, owner, name, prNumber, body, ctx);
    log.info("Build PR handed off to a human", { ...ctx, reason: handReason, outcome, commented, alreadyCommented: already });
    await appendDecision(deps.db, run, {
      trigger,
      decision: "hand-off",
      reason: handReason,
      headSha,
      ...(outcome ? { outcome } : {}),
      ...(commented ? { commented } : {}),
    });
    return { decision: "hand-off", reason: handReason, ...(outcome ? { outcome } : {}) };
  };

  if (decision === "merge" && review) {
    // GitHub already refused a merge of THIS head as `not-mergeable` (squash
    // merging disabled, a required merge queue, required signatures — refusals
    // that do not go away while `mergeable_state` still reads `clean`). The
    // PUT is not sent again: a new push is a new head, and gets one fresh try.
    if (priorEntries(run).some((e) => e.outcome === "not-mergeable" && e.headSha === headSha)) {
      return handOff(NOT_MERGEABLE_REASON, notMergeableComment(review));
    }
    // The decision already holds `review.reviewedSha === state.headSha`; the
    // reviewed SHA is passed because it is the evidence, and GitHub refuses the
    // merge if the head is anything else by the time it lands.
    const res = await github.mergePullRequest(owner, name, prNumber, {
      sha: review.reviewedSha,
      method: "squash",
    });
    if (res.outcome === "not-mergeable") {
      log.warn("Merge refused by GitHub as not mergeable", { ...ctx, message: res.message });
      return handOff(NOT_MERGEABLE_REASON, notMergeableComment(review, res.message), "not-mergeable");
    }
    let commented = false;
    if (res.outcome === "merged") {
      log.info("Merged build PR", { ...ctx, sha: res.sha });
      commented = await comment(github, owner, name, prNumber, mergedComment(repo, prNumber, review, res.sha), ctx);
      emitMerged(run, repo, prNumber, res.sha ?? "");
    } else {
      // `head-moved` / `already-merged`: the next evaluation reads the new state.
      log.info("Merge refused by GitHub", { ...ctx, outcome: res.outcome, message: res.message });
    }
    await appendDecision(deps.db, run, {
      trigger,
      decision,
      reason,
      headSha,
      outcome: res.outcome,
      ...(commented ? { commented } : {}),
    });
    return { decision, outcome: res.outcome, reason };
  }

  // The hold label means "stop acting on this subject", commenting included.
  if (decision === "hand-off" && reasonCase(reason) === ON_HOLD_CASE) return handOff(reason, null);
  if (decision === "hand-off") return handOff(reason, handOffComment(reason, review));

  log.debug("Build PR not merged yet", ctx);
  await appendDecision(deps.db, run, { trigger, decision, reason, headSha });
  return { decision, reason };
}

/** The hand-off reason after GitHub refused the merge itself. Case: `not-mergeable`. */
const NOT_MERGEABLE_REASON =
  "not-mergeable: GitHub refused the squash merge of this head; the gate will not retry it";

/** `mayMergeBuild`'s reason case for the instance hold label. */
const ON_HOLD_CASE = "on-hold";

/** Label names off a REST issue's `labels` (strings or `{ name }`). */
function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (typeof l === "string" ? l : (l as { name?: unknown } | null)?.name))
    .filter((n): n is string => typeof n === "string" && n !== "");
}

/**
 * The succeeded build run that recorded THIS PR, and the issue it ran for, or null.
 *
 * A build run is keyed by its issue (`owner/repo#N`), so the PR's closing
 * issues are the lookup key: the latest succeeded `build` run for each, kept
 * only when its review record names this PR number. Newest first when several
 * match. Anything else, including a PR that closes no issue, is null, so the
 * PR waits for a human.
 */
async function findBuildRun(
  deps: BuildMergeDeps,
  owner: string,
  name: string,
  prNumber: number,
): Promise<{ run: WorkflowRun; issueNumber: number } | null> {
  const repo = `${owner}/${name}`;
  const issues = await deps.github.listPullRequestClosingIssues(owner, name, prNumber);
  let best: { run: WorkflowRun; issueNumber: number } | null = null;
  for (const issue of issues) {
    const run = await deps.db.runs.latestSucceededForTrigger(BUILD_WORKFLOW, issueTriggerId(repo, issue.number));
    if (!run || run.status !== "succeeded" || run.workflowName !== BUILD_WORKFLOW) continue;
    if (readBuildReview(run)?.prNumber !== prNumber) continue;
    if (!best || run.startedAt > best.run.startedAt) best = { run, issueNumber: issue.number };
  }
  return best;
}

type PullRequest = Awaited<ReturnType<GitHubClient["getPullRequest"]>>;

/** The PR fields {@link mayMergeBuild} reads, on an otherwise inert snapshot. */
function snapshot(
  repo: string,
  prNumber: number,
  pr: PullRequest,
  botLogin: string,
  checks: { state: PrState["checksState"]; settledCount: number } | null,
): PrState {
  const state = emptyPrState(repo, prNumber);
  state.headSha = pr.head?.sha ?? "";
  state.headRef = pr.head?.ref ?? "";
  state.baseRef = pr.base?.ref ?? "";
  state.isDraft = !!pr.draft;
  state.authorLogin = pr.user?.login ?? "";
  state.authorIsOurs = !!botLogin && state.authorLogin === botLogin;
  state.title = pr.title ?? "";
  state.labels = (pr.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l?.name ?? ""))
    .filter(Boolean);
  state.headRepoFullName = pr.head?.repo?.full_name ?? null;
  const baseRepo = pr.base?.repo?.full_name ?? repo;
  state.isFork = state.headRepoFullName === null || state.headRepoFullName !== baseRepo;
  if (checks) {
    state.checksState = checks.state;
    state.settledCheckCount = checks.settledCount;
  }
  return state;
}

/** The App slug behind `<slug>[bot]`: our own `last-light/review` check is excluded from the count. */
function appSlug(botLogin: string): string | undefined {
  return botLogin.replace(/\[bot\]$/, "") || undefined;
}

// ── Comments and events ──────────────────────────────────────────────────────

/**
 * The reason as an inline code span. The reason is built by `mayMergeBuild`
 * from our own literals, but a protected-path reason names a path from the PR;
 * inside a code span it can neither format nor mention anyone, and a backtick
 * in it is replaced so it cannot close the span.
 */
function codeSpan(text: string): string {
  return "`" + text.replace(/[`\r\n]/g, "'").slice(0, 300) + "`";
}

function handOffComment(reason: string, review: BuildReviewRecord | null): string {
  const lines = [
    `The merge gate will not merge this PR on its own: ${codeSpan(reason)}.`,
    "",
    "It needs a human to review and merge it, or to fix what is listed above.",
  ];
  if (review?.verdictUrl) lines.push("", `Build review: [verdict](${review.verdictUrl})`);
  return lines.join("\n");
}

function notMergeableComment(review: BuildReviewRecord, githubMessage?: string): string {
  const lines = [
    "The merge gate tried to squash-merge this PR and GitHub refused it" +
      (githubMessage ? `: ${codeSpan(githubMessage)}.` : "."),
    "",
    "The gate will not try this commit again. A human needs to merge it, or to change the " +
      "repository setting that blocks it (for example squash merging disabled, a merge queue, " +
      "or required signed commits). A new push gets one fresh attempt.",
  ];
  if (review.verdictUrl) lines.push("", `Build review: [verdict](${review.verdictUrl})`);
  return lines.join("\n");
}

function mergedComment(repo: string, prNumber: number, review: BuildReviewRecord, sha?: string): string {
  const lines = [
    `Merged by the merge gate as squash commit ${sha ? codeSpan(sha) : "(SHA not reported)"}.`,
    "",
    `- Build review approved head ${codeSpan(review.reviewedSha)}` +
      (review.verdictUrl ? `: [verdict](${review.verdictUrl})` : ""),
    `- Checks: [green on that head](https://github.com/${repo}/pull/${prNumber}/checks)`,
  ];
  return lines.join("\n");
}

/** Post a comment; never throws. Returns whether it was posted. */
async function comment(
  github: GitHubClient,
  owner: string,
  name: string,
  prNumber: number,
  body: string,
  ctx: Record<string, unknown>,
): Promise<boolean> {
  try {
    await github.postComment(owner, name, prNumber, body);
    return true;
  } catch (err: unknown) {
    log.warn("Failed to post merge-gate comment", { ...ctx, err });
    return false;
  }
}

function emitMerged(run: WorkflowRun, repo: string, prNumber: number, sha: string): void {
  if (!runtime.emitter) return;
  try {
    const payload = buildRunPayload(
      "run.merged",
      run,
      { merge: { prNumber, sha } },
      { botName: runtime.botName, dashboardBase: runtime.dashboardBase, now: new Date() },
    );
    runtime.emitter.emit(payload, repo);
  } catch (err: unknown) {
    log.warn("Failed to emit run.merged", { repo, prNumber, err });
  }
}
