/**
 * The BUILD dispatch gate — the impure applier around `resolveBuildTrigger`.
 *
 * `build-decisions.test.ts` already tables every branch of the POLICY, so
 * nothing here re-tests a decision. What these cases protect is the part a pure
 * function cannot: that the inputs are resolved from the real config and the
 * real state DB, and that the one consequence belonging to the decision — the
 * stage-label advance, **guard 2** — actually happens, in the right direction,
 * on exactly the dispatches that earn it.
 *
 * So they run against a real `StateDb` and a real `advanceStage`, with only
 * GitHub faked. The label assertions are made on the CLIENT calls rather than on
 * a mocked `advanceStage`, because "the entry label came off before the run
 * started" is a claim about what reached GitHub — mocking the advance would fake
 * exactly the link the sweep's re-pickup guard depends on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyBuildDispatchGate, type BuildGateArgs } from "#src/engine/build-gate.js";
import { issueTriggerId } from "#src/engine/build-decisions.js";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import {
  STAGE_READY_FOR_AGENT,
  STAGE_AGENT_BUILDING,
  STAGE_AGENT_BLOCKED,
  STAGE_READY_FOR_HUMAN,
} from "#src/engine/stage-labels.js";
import type { AutonomyBudgetConfig } from "#src/config/config.js";
import { makeTestDb } from "../helpers/state-db.js";
import type { StateDb } from "#src/state/db.js";
import type { GitHubClient } from "#src/engine/github/github.js";

// The gate and `advanceStage` log through the pino LoggerPort; mock it so the
// suite's stderr stays free of real JSON from the degradation cases.
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

const REPO = "cliftonc/lastlight";
const ISSUE = 412;
const HOLD = "lastlight-ignore";

interface OpenPr {
  number: number;
  headRef: string;
  authorLogin: string;
  headRepoFullName: string | null;
}
const BOT = "last-light[bot]";
/** The bot's own same-repo build PR, unless a case overrides a field. */
const botPr = (headRef: string, over: Partial<OpenPr> = {}) => ({
  number: 8,
  headRef,
  authorLogin: BOT,
  headRepoFullName: REPO,
  ...over,
});

/** A GitHub stand-in that records the two label writes the advance is made of. */
function fakeGithub(
  over: {
    addLabels?: () => Promise<void>;
    live?: () => Promise<unknown>;
    openPrs?: () => Promise<Array<Partial<OpenPr> & { number: number; headRef: string }>>;
  } = {},
) {
  const addLabels = vi.fn(async (_o: string, _r: string, _n: number, _names: string[]) => {
    if (over.addLabels) await over.addLabels();
  });
  const removeLabel = vi.fn(async () => {});
  const postComment = vi.fn(async () => 1);
  const getIssue = vi.fn(async () => (over.live ? over.live() : { labels: [], state: "open" }));
  const listOpenPullRequests = vi.fn(async (_o: string, _r: string) => (over.openPrs ? over.openPrs() : []));
  return { addLabels, removeLabel, postComment, getIssue, listOpenPullRequests } as unknown as GitHubClient & {
    listOpenPullRequests: ReturnType<typeof vi.fn>;
    getIssue: ReturnType<typeof vi.fn>;
    addLabels: ReturnType<typeof vi.fn>;
    removeLabel: ReturnType<typeof vi.fn>;
    postComment: ReturnType<typeof vi.fn>;
  };
}

/** A clean human-applied `ready-for-agent`. Each case overrides what it is about. */
function args(over: Partial<BuildGateArgs> = {}): BuildGateArgs {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    labels: [STAGE_READY_FOR_AGENT],
    addedLabel: STAGE_READY_FOR_AGENT,
    route: "labeled",
    senderIsBot: false,
    stage: "build",
    ...over,
  };
}

/** A prior `build` run for this issue — what `alreadyBuilt` reads. */
async function seedBuildRun(db: StateDb, status: "succeeded" | "running" = "succeeded") {
  await db.runs.createRun({
    id: `run-${status}-${Math.random().toString(36).slice(2)}`,
    workflowName: "build",
    triggerId: issueTriggerId(REPO, ISSUE),
    owner: "cliftonc",
    repo: "lastlight",
    issueNumber: ISSUE,
    currentPhase: "architect",
    status,
    startedAt: new Date().toISOString(),
  });
}

describe("applyBuildDispatchGate", () => {
  let db: StateDb;
  let overlayDir: string;

  /**
   * Re-write the overlay and reload config. The budget is real config rather
   * than a stub for the same reason the allow-list is: these ceilings are read
   * through `getAutonomyConfig()`, and a stubbed value would let the block's
   * shape drift from what a deployment actually gets.
   */
  function useBudget(budget: Partial<AutonomyBudgetConfig> = {}, extraYaml = ""): void {
    const lines = Object.entries(budget)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join("\n");
    writeFileSync(
      join(overlayDir, "config.yaml"),
      `autonomy:\n  repos:\n    - "${REPO}"\n` + (lines ? `  budget:\n${lines}\n` : "") + extraYaml,
    );
    loadConfig();
  }

  beforeEach(async () => {
    db = await makeTestDb();
    // Real config, loaded from a real overlay — the gate reads `autonomy.repos`,
    // the stage's labels and the hold label, and a stubbed config would let all
    // three drift from what a deployment actually gets.
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
    overlayDir = mkdtempSync(join(tmpdir(), "build-gate-"));
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayDir);
    useBudget();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("clears a STALE terminal verdict as it advances into `running`", async () => {
    // A run STARTING means neither terminal verdict holds any more, and nothing
    // else ever clears them: this advance removes `enter`, the terminal observer
    // removes `running`. Without this an issue that failed, was re-run and
    // succeeded keeps `agent-blocked` beside its new `ready-for-human` forever,
    // and the board files the finished build under the older, scarier label.
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(
      args({ labels: [STAGE_READY_FOR_AGENT, STAGE_AGENT_BLOCKED] }),
      { db, github },
    );

    expect(result.decision).toBe("dispatch");
    expect(github.addLabels).toHaveBeenCalledWith("cliftonc", "lastlight", ISSUE, [
      STAGE_AGENT_BUILDING,
    ]);
    const removed = github.removeLabel.mock.calls.map((c: unknown[]) => c[3]);
    expect(removed).toContain(STAGE_READY_FOR_AGENT);
    expect(removed).toContain(STAGE_AGENT_BLOCKED);
    expect(removed).toContain(STAGE_READY_FOR_HUMAN);
    // Never the label it just applied.
    expect(removed).not.toContain(STAGE_AGENT_BUILDING);
  });

  it("dispatches a clean issue — and advances the label BEFORE the run, entry off", async () => {
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args(), { db, github });

    expect(result.decision).toBe("dispatch");
    expect(result.reason).toMatch(/^ready:/);
    // Guard 2, in the direction that matters: the running label ON…
    expect(github.addLabels).toHaveBeenCalledWith("cliftonc", "lastlight", ISSUE, [
      STAGE_AGENT_BUILDING,
    ]);
    // …and the ENTRY label off, which is what the sweep's `label:<enter>` query
    // can no longer find.
    expect(github.removeLabel).toHaveBeenCalledWith(
      "cliftonc",
      "lastlight",
      ISSUE,
      STAGE_READY_FOR_AGENT,
    );
  });

  it("skips an issue carrying the queued label on every route, and never advances its label", async () => {
    for (const route of ["labeled", "sweep", "api"] as const) {
      const github = fakeGithub({ live: async () => ({ labels: [STAGE_READY_FOR_AGENT, "lastlight:queued"] }) });
      const result = await applyBuildDispatchGate(
        args({ route, labels: [STAGE_READY_FOR_AGENT, "lastlight:queued"] }),
        { db, github },
      );
      expect(result.decision).toBe("skip");
      expect(result.reason).toBe(
        `queued: ${REPO}#${ISSUE} carries lastlight:queued; it builds once promotion clears it`,
      );
      expect(result.gates).toBeUndefined();
      expect(github.addLabels).not.toHaveBeenCalled();
      expect(github.removeLabel).not.toHaveBeenCalled();
    }
  });

  describe("a just-promoted issue (stale webhook labels)", () => {
    const stale = [STAGE_READY_FOR_AGENT, "lastlight:queued"];

    it("dispatches when the live labels no longer carry queued", async () => {
      const github = fakeGithub({ live: async () => ({ labels: [{ name: STAGE_READY_FOR_AGENT }], state: "open" }) });
      const result = await applyBuildDispatchGate(args({ labels: stale }), { db, github });
      expect(github.getIssue).toHaveBeenCalledTimes(1);
      expect(result.decision).toBe("dispatch");
    });

    it("skips when the live labels still carry queued", async () => {
      const github = fakeGithub({ live: async () => ({ labels: [STAGE_READY_FOR_AGENT, "LastLight:Queued"], state: "open" }) });
      const result = await applyBuildDispatchGate(args({ labels: stale }), { db, github });
      expect(result.decision).toBe("skip");
      expect(result.reason).toMatch(/^queued:/);
      expect(github.addLabels).not.toHaveBeenCalled();
    });

    it("treats the issue as queued when the live read throws", async () => {
      const github = fakeGithub({ live: async () => { throw new Error("boom"); } });
      const result = await applyBuildDispatchGate(args({ labels: stale }), { db, github });
      expect(result.decision).toBe("skip");
      expect(result.reason).toMatch(/^queued:/);
      expect(github.addLabels).not.toHaveBeenCalled();
    });

    it("makes no extra GitHub read when the webhook labels carry no queued label", async () => {
      const github = fakeGithub();
      const result = await applyBuildDispatchGate(args(), { db, github });
      expect(result.decision).toBe("dispatch");
      expect(github.getIssue).not.toHaveBeenCalled();
    });
  });

  it("matches the queued label case-insensitively", async () => {
    const github = fakeGithub({ live: async () => ({ labels: [STAGE_READY_FOR_AGENT, "LastLight:QUEUED"] }) });
    const result = await applyBuildDispatchGate(
      args({ labels: [STAGE_READY_FOR_AGENT, "LastLight:QUEUED"] }),
      { db, github },
    );
    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^queued:/);
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("skips a queued issue on the escalation route", async () => {
    await seedBuildRun(db, "succeeded");
    const github = fakeGithub();
    const result = await applyBuildDispatchGate(
      args({ route: "escalation", senderIsBot: true, attempt: 2, labels: [STAGE_AGENT_BLOCKED, "lastlight:queued"] }),
      { db, github },
    );
    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^queued:/);
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("hands back the stage's gates, for the run's approval map to union", async () => {
    const result = await applyBuildDispatchGate(args(), { db, github: fakeGithub() });

    expect(result.gates).toEqual({ post_architect: true, post_reviewer: true });
  });

  it("skips a BOT re-label of an already-built issue — and touches no label", async () => {
    await seedBuildRun(db);
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args({ senderIsBot: true }), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^already-built:/);
    expect(result.gates).toBeUndefined();
    // A skip that moved a label would take the issue out of the pipeline for a
    // build that never ran.
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("dispatches a HUMAN re-label of the same issue — the retry asymmetry", async () => {
    await seedBuildRun(db);

    const result = await applyBuildDispatchGate(args({ senderIsBot: false }), {
      db,
      github: fakeGithub(),
    });

    expect(result.decision).toBe("dispatch");
    expect(result.reason).toMatch(/^retry:/);
  });

  describe("the escalation route", () => {
    /** The failed attempt-1 run the observer is escalating, as the store holds it. */
    async function seedAttempt(id: string, attempt: number, status: "failed" | "running" = "failed") {
      await db.runs.createRun({
        id,
        workflowName: "build",
        triggerId: issueTriggerId(REPO, ISSUE),
        owner: "cliftonc",
        repo: "lastlight",
        issueNumber: ISSUE,
        currentPhase: "executor",
        status,
        context: { _stage: "build", _autonomous: true, _attempt: attempt },
        // Later attempts start later, as they do in life — `latestForTrigger` orders on it.
        startedAt: new Date(Date.now() - 10_000 + attempt * 1000).toISOString(),
      });
    }
    const escalate = (attempt: number) =>
      args({ route: "escalation", senderIsBot: true, addedLabel: undefined, labels: [STAGE_AGENT_BUILDING], attempt });

    // Escalation ships off (`build.maxAttempts: 1`); these cases opt in.
    beforeEach(() => {
      useBudget({}, "build:\n  maxAttempts: 2\n");
    });

    it("with the packaged maxAttempts of 1, attempt 2 is not dispatched", async () => {
      useBudget();
      await seedAttempt("run-a1", 1);
      const result = await applyBuildDispatchGate(escalate(2), { db, github: fakeGithub() });
      expect(result.decision).toBe("skip");
      expect(result.reason).toMatch(/^attempts-exhausted:/);
    });

    it("dispatches attempt 2 although a build already ran — and keeps the issue on running", async () => {
      await seedAttempt("run-a1", 1);
      const github = fakeGithub();

      const result = await applyBuildDispatchGate(escalate(2), { db, github });

      expect(result.decision).toBe("dispatch");
      expect(result.reason).toMatch(/^escalation:/);
      // The advance re-asserts `running`; the failure label it clears was never applied.
      expect(github.addLabels).toHaveBeenCalledWith("cliftonc", "lastlight", ISSUE, [STAGE_AGENT_BUILDING]);
    });

    it("skips attempt 3 with maxAttempts 2", async () => {
      await seedAttempt("run-a1", 1);
      await seedAttempt("run-a2", 2);
      const result = await applyBuildDispatchGate(escalate(3), { db, github: fakeGithub() });
      expect(result.decision).toBe("skip");
      expect(result.reason).toMatch(/^attempts-exhausted:/);
    });

    it("skips a second escalation for the same (trigger, attempt) — one failed run, one retry", async () => {
      await seedAttempt("run-a1", 1);
      // The first escalation's run already exists for attempt 2 and has since ended.
      await seedAttempt("run-a2", 2);
      const result = await applyBuildDispatchGate(escalate(2), { db, github: fakeGithub() });
      expect(result.decision).toBe("skip");
      expect(result.reason).toMatch(/^already-escalated:/);
    });

    it("skips a second escalation that arrives before the first one's run row exists", async () => {
      await seedAttempt("run-a1", 1);
      const first = await applyBuildDispatchGate(escalate(2), { db, github: fakeGithub() });
      const second = await applyBuildDispatchGate(escalate(2), { db, github: fakeGithub() });
      expect(first.decision).toBe("dispatch");
      expect(second.decision).toBe("skip");
      expect(second.reason).toMatch(/^already-escalated:/);
    });

    it("a human restart opens a fresh chain: an OLDER attempt-2 run does not block it", async () => {
      // Chain 1 ran attempts 1 and 2 and handed off; `@bot retry` started a new
      // attempt 1, which has now failed. Only the LATEST run is the key.
      useBudget({ maxBuildsPerRepoPerDay: 10 }, "build:\n  maxAttempts: 2\n");
      await seedAttempt("run-old-a1", 1);
      await seedAttempt("run-old-a2", 2);
      await db.runs.createRun({
        id: "run-new-a1",
        workflowName: "build",
        triggerId: issueTriggerId(REPO, ISSUE),
        owner: "cliftonc",
        repo: "lastlight",
        issueNumber: ISSUE,
        currentPhase: "executor",
        status: "failed",
        context: { _stage: "build", _autonomous: true, _attempt: 1 },
        startedAt: new Date().toISOString(),
      });
      const result = await applyBuildDispatchGate(escalate(2), { db, github: fakeGithub() });
      expect(result.decision).toBe("dispatch");
    });

    it("a BOT re-label of an already-built issue still skips", async () => {
      await seedAttempt("run-a1", 1);
      const result = await applyBuildDispatchGate(args({ senderIsBot: true, attempt: 2 }), { db, github: fakeGithub() });
      expect(result.decision).toBe("skip");
      expect(result.reason).toMatch(/^already-built:/);
    });
  });

  it("skips a held issue silently — no label, no advance", async () => {
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(
      args({ labels: [STAGE_READY_FOR_AGENT, HOLD] }),
      { db, github },
    );

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^on-hold:/);
    expect(github.addLabels).not.toHaveBeenCalled();
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("skips a repo that is not on the autonomy allow-list", async () => {
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args({ repo: "other/repo" }), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^not-autonomous:/);
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("skips while a build run for the issue is live", async () => {
    await seedBuildRun(db, "running");

    // A HUMAN retry, so the already-built branch cannot be what answers: two
    // agents in one workspace is physical, and no instruction overrides it.
    const result = await applyBuildDispatchGate(args({ senderIsBot: false }), {
      db,
      github: fakeGithub(),
    });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^run-in-flight:/);
  });

  it("still dispatches when the advance FAILS — guard 2 degrades, guard 3 holds", async () => {
    const github = fakeGithub({
      addLabels: async () => {
        throw new Error("GitHub is down");
      },
    });

    const result = await applyBuildDispatchGate(args(), { db, github });

    expect(result.decision).toBe("dispatch");
    // The ordering rule: a failed ADD must not be followed by the remove, or the
    // issue leaves the pipeline carrying neither label.
    expect(github.removeLabel).not.toHaveBeenCalled();
  });

  it("dispatches in chat-only mode, where there is no GitHub to label", async () => {
    const result = await applyBuildDispatchGate(args(), { db, github: null });

    expect(result.decision).toBe("dispatch");
  });

  it("skips an unknown stage name rather than running un-gated", async () => {
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args({ stage: "ghost" }), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^unknown-stage:/);
    expect(github.addLabels).not.toHaveBeenCalled();
  });
});

/**
 * THE SKIP CONSEQUENCES — the half a pure function cannot have.
 *
 * `build-decisions.test.ts` already pins WHICH budget branch answers; nothing
 * here re-tests that. What these cases protect is the proportionality rule from
 * `pr-escalation.ts`: a transient skip costs a log line, a configured ceiling
 * costs an audit row, and only the terminal-for-today one reaches the issue —
 * exactly once, keyed on the label rather than on its own prose.
 *
 * The de-duplication case is the load-bearing one. The budget does not clear
 * until midnight, so every sweep tick between the refusal and then comes back
 * through this code. A dedup that failed would not be a cosmetic bug; it would
 * be a comment every twenty minutes on somebody's issue.
 */
describe("applyBuildDispatchGate — budget skip consequences", () => {
  let db: StateDb;
  let overlayDir: string;

  function useBudget(budget: Partial<AutonomyBudgetConfig> = {}, extraYaml = ""): void {
    const lines = Object.entries(budget)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join("\n");
    writeFileSync(
      join(overlayDir, "config.yaml"),
      `autonomy:\n  repos:\n    - "${REPO}"\n` + (lines ? `  budget:\n${lines}\n` : "") + extraYaml,
    );
    loadConfig();
  }

  /** A finished build run for a DIFFERENT issue on this repo — quota, not dedup. */
  async function seedRepoBuild(n: number): Promise<void> {
    await db.runs.createRun({
      id: `quota-${n}`,
      workflowName: "build",
      triggerId: issueTriggerId(REPO, 900 + n),
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: 900 + n,
      currentPhase: "architect",
      status: "succeeded",
      startedAt: new Date().toISOString(),
    });
  }

  /** A live build run for another issue — the concurrency input. */
  async function seedActiveBuild(
    n: number,
    autonomous: boolean,
    status: "running" | "queued" | "paused" = "running",
  ): Promise<void> {
    await db.runs.createRun({
      id: `live-${n}`,
      workflowName: "build",
      triggerId: issueTriggerId(REPO, 800 + n),
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: 800 + n,
      currentPhase: status === "paused" ? "waiting_approval" : "architect",
      status,
      context: autonomous ? { _autonomous: true } : {},
      startedAt: new Date().toISOString(),
    });
  }

  /** Model spend recorded against this repo today. */
  async function seedSpend(usd: number): Promise<void> {
    const id = `exec-${Math.random().toString(36).slice(2)}`;
    await db.executions.recordStart({
      id,
      skill: "build",
      triggerType: "webhook",
      triggerId: issueTriggerId(REPO, 901),
      repo: REPO,
      issueNumber: 901,
      startedAt: new Date().toISOString(),
    });
    await db.executions.recordFinish(id, { success: true, costUsd: usd });
  }

  async function activityRows() {
    return (await db.activity.list()).activity;
  }

  beforeEach(async () => {
    db = await makeTestDb();
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
    overlayDir = mkdtempSync(join(tmpdir(), "build-gate-budget-"));
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayDir);
    useBudget();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("a repo over its daily quota: an activity row, and NOTHING on the issue", async () => {
    useBudget({ maxBuildsPerRepoPerDay: 1 });
    await seedRepoBuild(1);
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args(), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^repo-quota-exhausted:/);

    // Recorded — a ceiling somebody configured and may want to raise.
    const rows = await activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "autonomy.skip",
      outcome: "denied",
      targetType: "issue",
      targetId: issueTriggerId(REPO, ISSUE),
    });
    expect(rows[0]!.detail).toMatchObject({ case: "repo-quota-exhausted" });

    // But not commented, and not labelled: the issue WILL be built, just not
    // today, so there is nothing terminal to say on it.
    expect(github.postComment).not.toHaveBeenCalled();
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("a budget-exhausted skip comments exactly once and applies the blocked label", async () => {
    useBudget({ dailyUsd: 1 });
    await seedSpend(5);
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args(), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^budget-exhausted:/);

    expect(github.addLabels).toHaveBeenCalledTimes(1);
    expect(github.addLabels).toHaveBeenCalledWith("cliftonc", "lastlight", ISSUE, [
      STAGE_AGENT_BLOCKED,
    ]);
    expect(github.postComment).toHaveBeenCalledTimes(1);

    const body = github.postComment.mock.calls[0]![3] as string;
    // The three things the comment owes a human: which ceiling (with its
    // configured value), when it resets, and how to get out.
    expect(body).toContain("$1.00");
    expect(body).toContain("midnight UTC");
    expect(body).toContain(STAGE_AGENT_BLOCKED);

    expect(await activityRows()).toHaveLength(1);
  });

  it("names the REPO's ceiling when that is the one that was hit", async () => {
    // Harness spend is inside its own ceiling; only the repo's is blown.
    useBudget({ repoDailyUsd: 1 });
    await seedSpend(5);
    const github = fakeGithub();

    await applyBuildDispatchGate(args(), { db, github });

    const body = github.postComment.mock.calls[0]![3] as string;
    expect(body).toContain(REPO);
  });

  it("says NOTHING the second time — the dedup keys on the label, not on the prose", async () => {
    useBudget({ dailyUsd: 1 });
    await seedSpend(5);
    const github = fakeGithub();

    // The issue now carries the blocked label the first refusal applied. This
    // is what every sweep tick between now and midnight looks like.
    const result = await applyBuildDispatchGate(
      args({ labels: [STAGE_READY_FOR_AGENT, STAGE_AGENT_BLOCKED] }),
      { db, github },
    );

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^budget-exhausted:/);
    expect(github.postComment).not.toHaveBeenCalled();
    expect(github.addLabels).not.toHaveBeenCalled();

    // The audit row is NOT deduped, deliberately: each refusal is a real event,
    // and the stream is where "how often is this happening" gets answered.
    expect(await activityRows()).toHaveLength(1);
  });

  it("a concurrency skip is logged only — no row, no comment", async () => {
    // It clears itself within minutes and fires on every tick while it holds,
    // so a row per tick would be noise in the one stream whose value is that a
    // human can read it.
    useBudget({ maxConcurrentBuilds: 1 });
    await seedActiveBuild(1, true);
    const github = fakeGithub();

    const result = await applyBuildDispatchGate(args(), { db, github });

    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/^concurrency-exhausted:/);
    expect(await activityRows()).toHaveLength(0);
    expect(github.postComment).not.toHaveBeenCalled();
    expect(github.addLabels).not.toHaveBeenCalled();
  });

  it("a NON-autonomous build in flight does not consume the concurrency ceiling", async () => {
    // The ceiling bounds unattended work. A build a human asked for by comment
    // is not spending that budget and must not exhaust it.
    useBudget({ maxConcurrentBuilds: 1 });
    await seedActiveBuild(1, false);

    const result = await applyBuildDispatchGate(args(), { db, github: fakeGithub() });

    expect(result.decision).toBe("dispatch");
  });

  it("a build PAUSED on a human does not consume the concurrency ceiling", async () => {
    // A run waiting at an approval gate holds no agent and no sandbox slot.
    // Counting it let two architect plans awaiting review stop the whole
    // pipeline (nearform, 2026-09-16).
    useBudget({ maxConcurrentBuilds: 1 });
    await seedActiveBuild(1, true, "paused");
    await seedActiveBuild(2, true, "paused");

    const result = await applyBuildDispatchGate(args(), { db, github: fakeGithub() });

    expect(result.decision).toBe("dispatch");
  });

  it("a QUEUED autonomous build still consumes the ceiling — it is about to run", async () => {
    useBudget({ maxConcurrentBuilds: 1 });
    await seedActiveBuild(1, true, "queued");

    const result = await applyBuildDispatchGate(args(), { db, github: fakeGithub() });

    expect(result.reason).toMatch(/^concurrency-exhausted:/);
  });

  it("gates a burst atomically — one sweep tick cannot dispatch past the ceiling", async () => {
    // The fan-out gates every discovered issue in parallel, and none of their
    // run rows exist yet when the others read the count. Seven issues against a
    // ceiling of one all read zero and all dispatched.
    useBudget({ maxConcurrentBuilds: 1 });
    const github = fakeGithub();

    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7].map((n) =>
        applyBuildDispatchGate(args({ issueNumber: 100 + n }), { db, github }),
      ),
    );

    expect(results.filter((r) => r.decision === "dispatch")).toHaveLength(1);
    expect(results.filter((r) => /^concurrency-exhausted:/.test(r.reason))).toHaveLength(6);
  });

  it("does not count an issue's own reservation against it — the board gates twice", async () => {
    // The board route crosses the gate, then `dispatchWorkflow` crosses it again
    // for the same issue before the run row exists.
    useBudget({ maxConcurrentBuilds: 1 });
    const github = fakeGithub();

    expect((await applyBuildDispatchGate(args({ route: "api" }), { db, github })).decision).toBe("dispatch");
    expect((await applyBuildDispatchGate(args({ route: "api" }), { db, github })).decision).toBe("dispatch");
  });

  it("releases a reservation once its run exists — the row is the count from then on", async () => {
    useBudget({ maxConcurrentBuilds: 1 });
    const github = fakeGithub();
    expect((await applyBuildDispatchGate(args({ issueNumber: 1 }), { db, github })).decision).toBe("dispatch");

    // The dispatched run starts, then stops at its approval gate.
    await db.runs.createRun({
      id: "burst-1",
      workflowName: "build",
      triggerId: issueTriggerId(REPO, 1),
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: 1,
      currentPhase: "waiting_approval",
      status: "paused",
      context: { _autonomous: true },
      startedAt: new Date().toISOString(),
    });

    expect((await applyBuildDispatchGate(args({ issueNumber: 2 }), { db, github })).decision).toBe("dispatch");
  });

  it("counts a dispatch ONCE when its run row appears — the reservation gives way to the row", async () => {
    useBudget({ maxConcurrentBuilds: 2 });
    const github = fakeGithub();
    expect((await applyBuildDispatchGate(args({ issueNumber: 1 }), { db, github })).decision).toBe("dispatch");
    await db.runs.createRun({
      id: "realised-1",
      workflowName: "build",
      triggerId: issueTriggerId(REPO, 1),
      owner: "cliftonc",
      repo: "lastlight",
      issueNumber: 1,
      currentPhase: "architect",
      status: "running",
      context: { _autonomous: true },
      startedAt: new Date(Date.now() + 1).toISOString(),
    });

    // One running row against a ceiling of two. Had the reservation for issue 1
    // survived beside its row, the count would read two and refuse this.
    expect((await applyBuildDispatchGate(args({ issueNumber: 2 }), { db, github })).decision).toBe("dispatch");
  });

  it("no budget skip EVER advances the issue to the running label", async () => {
    // A skip that moved the stage on would take the issue out of the pipeline
    // for a build that never ran — the one label write that is never correct
    // here.
    for (const budget of [
      { maxConcurrentBuilds: 0 },
      { maxBuildsPerRepoPerDay: 0 },
      { dailyUsd: 0 },
    ]) {
      useBudget(budget);
      const github = fakeGithub();
      const result = await applyBuildDispatchGate(args(), { db, github });

      expect(result.decision).toBe("skip");
      expect(github.addLabels).not.toHaveBeenCalledWith(
        "cliftonc",
        "lastlight",
        ISSUE,
        [STAGE_AGENT_BUILDING],
      );
      // And the entry label stays on: the issue has not left the queue.
      expect(github.removeLabel).not.toHaveBeenCalled();
    }
  });
  describe("already handed off (stale ready-for-agent beside a hand-off, or an open build PR)", () => {
    const noWrites = (github: ReturnType<typeof fakeGithub>) => {
      expect(github.addLabels).not.toHaveBeenCalled();
      expect(github.removeLabel).not.toHaveBeenCalled();
      expect(github.postComment).not.toHaveBeenCalled();
    };

    it("skips `handed-off` an issue carrying ready-for-human beside a stale ready-for-agent, on every route", async () => {
      for (const route of ["labeled", "sweep"] as const) {
        const github = fakeGithub();
        const result = await applyBuildDispatchGate(
          args({ route, labels: [STAGE_READY_FOR_AGENT, STAGE_READY_FOR_HUMAN] }),
          { db, github },
        );
        expect(result.decision).toBe("skip");
        expect(result.reason).toMatch(/^handed-off:/);
        noWrites(github);
      }
    });

    it("matches the hand-off label case-insensitively", async () => {
      const github = fakeGithub();
      const result = await applyBuildDispatchGate(
        args({ route: "sweep", labels: [STAGE_READY_FOR_AGENT, "Ready-For-Human"] }),
        { db, github },
      );
      expect(result.decision).toBe("skip");
      expect(result.reason).toMatch(/^handed-off:/);
    });

    it("skips `handed-off` an issue with an OPEN lastlight/<N>-… PR (factory-test #7 / #8)", async () => {
      const github = fakeGithub({ openPrs: async () => [botPr(`lastlight/${ISSUE}-fix-the-thing`)] });
      const result = await applyBuildDispatchGate(args({ route: "sweep" }), { db, github });
      expect(result.decision).toBe("skip");
      expect(result.reason).toMatch(/^handed-off:/);
      expect(result.reason).toContain("#8");
      noWrites(github);
    });

    it("dispatches when the open PR is from another branch (incl. another issue's number prefix)", async () => {
      const github = fakeGithub({
        openPrs: async () => [
          { number: 3, headRef: "feature/x" },
          { number: 4, headRef: `lastlight/${ISSUE}0-other` },
          { number: 5, headRef: `lastlight/${ISSUE}` },
        ],
      });
      const result = await applyBuildDispatchGate(args({ route: "sweep" }), { db, github });
      expect(result.decision).toBe("dispatch");
    });

    it("dispatches when a FORK PR carries a matching head ref (public-repo DoS)", async () => {
      const github = fakeGithub({
        openPrs: async () => [botPr(`lastlight/${ISSUE}-x`, { headRepoFullName: "mallory/lastlight" })],
      });
      expect((await applyBuildDispatchGate(args({ route: "sweep" }), { db, github })).decision).toBe("dispatch");
    });

    it("dispatches when a deleted-fork PR (no head repo) carries a matching head ref", async () => {
      const github = fakeGithub({ openPrs: async () => [botPr(`lastlight/${ISSUE}-x`, { headRepoFullName: null })] });
      expect((await applyBuildDispatchGate(args({ route: "sweep" }), { db, github })).decision).toBe("dispatch");
    });

    it("dispatches when a same-repo PR by a HUMAN carries a matching head ref", async () => {
      const github = fakeGithub({ openPrs: async () => [botPr(`lastlight/${ISSUE}-x`, { authorLogin: "alice" })] });
      expect((await applyBuildDispatchGate(args({ route: "sweep" }), { db, github })).decision).toBe("dispatch");
    });

    it("skips when the bot login cannot be resolved (fail closed)", async () => {
      const github = fakeGithub({ openPrs: async () => [] });
      const result = await applyBuildDispatchGate(args({ route: "sweep" }), { db, github, botLogin: "" });
      expect(result.decision).toBe("skip");
      expect(result.reason).toMatch(/^handed-off: could not check/);
    });

    it("dispatches when the build PR is closed or merged (the lookup lists open PRs only)", async () => {
      // `listOpenPullRequests` never returns a closed or merged PR, so a finished
      // build's PR reads as an empty list.
      const github = fakeGithub({ openPrs: async () => [] });
      const result = await applyBuildDispatchGate(args({ route: "sweep" }), { db, github });
      expect(result.decision).toBe("dispatch");
      expect(github.listOpenPullRequests).toHaveBeenCalledWith("cliftonc", "lastlight");
    });

    it("skips, failing closed, when the PR lookup throws", async () => {
      const github = fakeGithub({
        openPrs: async () => {
          throw new Error("github down");
        },
      });
      const result = await applyBuildDispatchGate(args({ route: "sweep" }), { db, github });
      expect(result.decision).toBe("skip");
      expect(result.reason).toMatch(/^handed-off:/);
      noWrites(github);
    });

    it("does not touch the escalation route: attempt 2 dispatches, even beside an open build PR", async () => {
      useBudget({}, "build:\n  maxAttempts: 2\n");
      await db.runs.createRun({
        id: "run-a1",
        workflowName: "build",
        triggerId: issueTriggerId(REPO, ISSUE),
        owner: "cliftonc",
        repo: "lastlight",
        issueNumber: ISSUE,
        currentPhase: "executor",
        status: "failed",
        context: { _stage: "build", _autonomous: true, _attempt: 1 },
        startedAt: new Date(Date.now() - 9_000).toISOString(),
      });
      const github = fakeGithub({ openPrs: async () => [botPr(`lastlight/${ISSUE}-x`)] });
      const result = await applyBuildDispatchGate(
        args({ route: "escalation", senderIsBot: true, addedLabel: undefined, labels: [STAGE_AGENT_BUILDING], attempt: 2 }),
        { db, github },
      );
      expect(result.decision).toBe("dispatch");
      expect(result.reason).toMatch(/^escalation:/);
    });

    it("a human retry (api route) ignores a stale hand-off label but still refuses to duplicate an open build PR", async () => {
      await seedBuildRun(db);
      const stale = args({ route: "api", labels: [STAGE_AGENT_BLOCKED, STAGE_READY_FOR_HUMAN] });
      const ok = await applyBuildDispatchGate(stale, { db, github: fakeGithub() });
      expect(ok.decision).toBe("dispatch");

      const withPr = fakeGithub({ openPrs: async () => [botPr(`lastlight/${ISSUE}-x`)] });
      const blocked = await applyBuildDispatchGate(args({ route: "api", labels: [STAGE_AGENT_BLOCKED] }), {
        db: await makeTestDb(),
        github: withPr,
      });
      expect(blocked.decision).toBe("skip");
      expect(blocked.reason).toMatch(/^handed-off:/);
    });

    it("regression guard: ready-for-agent alone with no PR still dispatches", async () => {
      const github = fakeGithub();
      const result = await applyBuildDispatchGate(args({ route: "sweep" }), { db, github });
      expect(result.decision).toBe("dispatch");
    });
  });
});
