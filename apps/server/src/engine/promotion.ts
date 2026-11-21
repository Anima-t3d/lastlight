/**
 * L2 — promote a queued issue once everything blocking it has closed.
 *
 * An issue parked under `autonomy.queuedLabel` is released to the build stage's
 * `enter` label when every issue that blocks it (GitHub issue dependencies) is
 * closed as COMPLETED. The existing build dispatch (webhook `issues.labeled`,
 * the backstop sweep, the build gate) then picks it up; nothing here dispatches
 * a build.
 *
 * Fail closed: a blocker that is closed with no reason, or `reopened`, is not
 * "completed", so the decision is `wait`. A blocker closed `not_planned` will
 * never be built, so the dependent is moved to the stage's `on_failure` label
 * with one fixed comment naming the blocker number (never the title or body of
 * anything: those are untrusted text).
 *
 * Only an issue still carrying the queued label is ever acted on, so
 * re-evaluating an already-promoted issue is a `skip` (`not-queued`). A blocker
 * reopening after promotion therefore does not demote it.
 *
 * Both executors swallow and log their errors per issue: they run on a webhook
 * path and a cron sweep, and one unreadable issue must not stop the rest.
 */

import type { GitHubClient } from "./github/github.js";
import type { Decision } from "./pr-decisions.js";
import { advanceStage } from "./stage-advance.js";
import { getAutonomyConfig, isAutonomousRepo } from "../config/config.js";
import { logger } from "../logging/logger.js";

const log = logger("promotion");

export type PromotionDecision = "promote" | "wait" | "block" | "skip";

export function resolvePromotion(
  issue: { labels: readonly string[]; state: "open" | "closed" },
  blockers: ReadonlyArray<{ state: "open" | "closed"; stateReason: string | null }>,
  cfg: { queuedLabel: string; autonomyEnabled: boolean },
): Decision<PromotionDecision> {
  const inputs = { state: issue.state, blockers: blockers.length };
  if (!cfg.autonomyEnabled) {
    return { decision: "skip", reason: "not-autonomous: the repo is not on the autonomy allow-list", inputs };
  }
  if (issue.state === "closed") {
    return { decision: "skip", reason: "closed: the issue is closed", inputs };
  }
  if (!issue.labels.includes(cfg.queuedLabel)) {
    return { decision: "skip", reason: `not-queued: the issue does not carry \`${cfg.queuedLabel}\``, inputs };
  }
  if (blockers.some((b) => b.state === "closed" && b.stateReason === "not_planned")) {
    return { decision: "block", reason: "blocker-not-planned: a blocker was closed as not planned", inputs };
  }
  if (blockers.some((b) => !(b.state === "closed" && b.stateReason === "completed"))) {
    return { decision: "wait", reason: "blockers-pending: a blocker is open or was not closed as completed", inputs };
  }
  return {
    decision: "promote",
    reason: blockers.length ? "unblocked: every blocker closed as completed" : "unblocked: no blockers",
    inputs,
  };
}

/** The subset of the GitHub client this needs. */
export type PromotionGitHub = Pick<
  GitHubClient,
  | "getIssue"
  | "listIssueDependencies"
  | "listOpenIssuesByLabel"
  | "addLabels"
  | "removeLabel"
  | "postComment"
>;
export interface PromotionDeps {
  github: PromotionGitHub | null;
}

function split(repo: string): [string, string] | null {
  const [owner, name] = repo.split("/");
  return owner && name ? [owner, name] : null;
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (typeof l === "string" ? l : (l as { name?: unknown } | null)?.name))
    .filter((n): n is string => typeof n === "string");
}

/** Evaluate one issue and act on the decision. Throws on a GitHub read failure. */
async function evaluate(
  github: PromotionGitHub,
  owner: string,
  repo: string,
  issueNumber: number,
  known?: { labels: readonly string[]; state: "open" | "closed" },
): Promise<void> {
  const autonomy = getAutonomyConfig();
  const stage = autonomy.stages.build;
  if (!stage || !stage.enter) return;

  let issue = known;
  if (!issue) {
    const got = await github.getIssue(owner, repo, issueNumber);
    issue = { labels: labelNames(got.labels), state: got.state === "closed" ? "closed" : "open" };
  }
  // Cheap exits before the dependency read.
  if (issue.state === "closed" || !issue.labels.includes(autonomy.queuedLabel)) return;

  const blockers = await github.listIssueDependencies(owner, repo, issueNumber, "blocked_by");
  const result = resolvePromotion(issue, blockers, { queuedLabel: autonomy.queuedLabel, autonomyEnabled: true });
  log.info("Promotion evaluated", { repo: `${owner}/${repo}`, issueNumber, decision: result.decision, reason: result.reason });

  if (result.decision === "promote") {
    await advanceStage(
      { owner, repo, issueNumber, from: autonomy.queuedLabel, to: stage.enter },
      { github: github as GitHubClient },
    );
  } else if (result.decision === "block") {
    const bad = blockers.find((b) => b.state === "closed" && b.stateReason === "not_planned");
    await advanceStage(
      { owner, repo, issueNumber, from: autonomy.queuedLabel, to: stage.on_failure },
      { github: github as GitHubClient },
    );
    if (bad) {
      await github.postComment(
        owner,
        repo,
        issueNumber,
        `This issue cannot be built automatically: its blocker #${bad.number} was closed as not planned. ` +
          `Resolve the dependency, then re-apply \`${stage.enter}\` to retry.`,
      );
    }
  }
}

/** `issues.closed`: evaluate every issue the closed one was blocking. */
export async function promoteDependents(deps: PromotionDeps, repo: string, closedIssue: number): Promise<void> {
  // Allow-list first: a repo that never opted in costs no GitHub call.
  if (!deps.github || !isAutonomousRepo(repo)) return;
  const parts = split(repo);
  if (!parts) return;
  const [owner, name] = parts;
  let dependents: Awaited<ReturnType<PromotionGitHub["listIssueDependencies"]>>;
  try {
    dependents = await deps.github.listIssueDependencies(owner, name, closedIssue, "blocking");
  } catch (err) {
    log.warn("Listing dependents failed", { repo, closedIssue, err });
    return;
  }
  for (const d of dependents) {
    try {
      await evaluate(deps.github, owner, name, d.number);
    } catch (err) {
      log.warn("Promotion evaluation failed", { repo, issueNumber: d.number, err });
    }
  }
}

/** The sweep: evaluate every open issue carrying the queued label. */
export async function promoteReadyQueued(deps: PromotionDeps, repo: string): Promise<void> {
  if (!deps.github || !isAutonomousRepo(repo)) return;
  const parts = split(repo);
  if (!parts) return;
  const [owner, name] = parts;
  let queued: Awaited<ReturnType<PromotionGitHub["listOpenIssuesByLabel"]>>;
  try {
    queued = await deps.github.listOpenIssuesByLabel(owner, name, getAutonomyConfig().queuedLabel);
  } catch (err) {
    log.warn("Listing queued issues failed", { repo, err });
    return;
  }
  for (const issue of queued) {
    try {
      await evaluate(deps.github, owner, name, issue.number, { labels: issue.labels, state: "open" });
    } catch (err) {
      log.warn("Promotion evaluation failed", { repo, issueNumber: issue.number, err });
    }
  }
}
