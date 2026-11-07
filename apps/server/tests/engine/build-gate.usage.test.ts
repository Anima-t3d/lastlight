import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { applyBuildDispatchGate, type BuildGateArgs } from "#src/engine/build-gate.js";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import { configureUsageGate, listUsageWaiting, resetUsageGateForTests } from "#src/engine/usage-runtime.js";
import { STAGE_READY_FOR_AGENT } from "#src/engine/stage-labels.js";
import { makeTestDb } from "../helpers/state-db.js";
import type { StateDb } from "#src/state/db.js";
import type { GitHubClient } from "#src/engine/github/github.js";
import type { WebhookPayload } from "#src/notify/webhook/types.js";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: () => noopLogger };
  return { logger: () => noopLogger };
});

/**
 * The usage branch of the build gate, end to end through real config and a
 * real state DB: the verdict is read from a usage file, an override in the DB
 * changes it, and a held window is announced once — not once per sweep tick.
 */
const REPO = "acme/widgets";

function github() {
  return {
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    postComment: vi.fn(async () => 1),
  } as unknown as GitHubClient & { postComment: ReturnType<typeof vi.fn> };
}

function args(issueNumber: number, over: Partial<BuildGateArgs> = {}): BuildGateArgs {
  return {
    repo: REPO,
    issueNumber,
    labels: [STAGE_READY_FOR_AGENT],
    route: "sweep",
    senderIsBot: true,
    stage: "build",
    ...over,
  };
}

describe("applyBuildDispatchGate — usage windows", () => {
  let db: StateDb;
  let dir: string;
  let usageFile: string;
  let emitted: Array<{ payload: WebhookPayload; repo?: string }>;
  const now = new Date("2026-11-07T10:00:00Z");

  function writeUsage(usedPct: number, resetsAt = "2026-11-07T13:00:00Z") {
    writeFileSync(
      usageFile,
      JSON.stringify({
        updatedAt: "2026-11-07T09:59:00Z",
        windows: [{ provider: "commandcode", id: "five_hour", usedPct, resetsAt }],
      }),
    );
  }

  function useConfig(usageBlock: string) {
    writeFileSync(
      join(dir, "config.yaml"),
      `autonomy:\n  repos:\n    - "${REPO}"\n  budget:\n    maxBuildsPerRepoPerDay: 50\n    maxConcurrentBuilds: 50\n${usageBlock}`,
    );
    loadConfig();
  }

  beforeEach(async () => {
    db = await makeTestDb();
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) vi.stubEnv(k, "");
    dir = mkdtempSync(join(tmpdir(), "usage-gate-"));
    usageFile = join(dir, "usage.json");
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", dir);
    useConfig(`    usage:\n      source: { file: ${usageFile} }\n`);
    emitted = [];
    configureUsageGate({
      emitter: { emit: (payload: WebhookPayload, repo?: string) => emitted.push({ payload, repo }) },
      now: () => now,
      botName: "last-light",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
    resetUsageGateForTests();
  });

  const heldRows = async () =>
    (await db.activity.list({ action: "autonomy.skip" })).activity.filter(
      (r) => (r.detail as { case?: string } | null)?.case === "usage-held",
    );

  it("holds an autonomous build while a window is over the threshold", async () => {
    writeUsage(85);
    const r = await applyBuildDispatchGate(args(1), { db, github: github() });
    expect(r.decision).toBe("skip");
    expect(r.reason).toMatch(/^usage-held: commandcode five_hour at 85%/);
  });

  it("dispatches below the threshold", async () => {
    writeUsage(50);
    expect((await applyBuildDispatchGate(args(1), { db, github: github() })).decision).toBe("dispatch");
  });

  it("is off without a source", async () => {
    useConfig("");
    writeUsage(100);
    expect((await applyBuildDispatchGate(args(1), { db, github: github() })).decision).toBe("dispatch");
  });

  it("three sweep ticks on the same held window: one autonomy.held and one activity row, no comment", async () => {
    writeUsage(85);
    const gh = github();
    for (let i = 0; i < 3; i++) await applyBuildDispatchGate(args(1), { db, github: gh });
    await applyBuildDispatchGate(args(2), { db, github: gh });
    expect(emitted.map((e) => e.payload.type)).toEqual(["autonomy.held"]);
    expect(emitted[0].repo).toBe(REPO);
    expect(emitted[0].payload.hold).toEqual({
      provider: "commandcode",
      window: "five_hour",
      usedPct: 85,
      maxPercent: 80,
      resetsAt: "2026-11-07T13:00:00Z",
    });
    expect(emitted[0].payload.subject).toMatchObject({ repo: REPO, issueNumber: 1 });
    expect(await heldRows()).toHaveLength(1);
    expect(gh.postComment).not.toHaveBeenCalled();
    expect(listUsageWaiting().map((w) => w.issueNumber).sort()).toEqual([1, 2]);
  });

  it("a new reset time is a new hold", async () => {
    writeUsage(85, "2026-11-07T13:00:00Z");
    await applyBuildDispatchGate(args(1), { db, github: github() });
    writeUsage(90, "2026-11-07T18:00:00Z");
    await applyBuildDispatchGate(args(1), { db, github: github() });
    expect(emitted).toHaveLength(2);
    expect(await heldRows()).toHaveLength(2);
  });

  it("a dispatched issue leaves the waiting list", async () => {
    writeUsage(85);
    await applyBuildDispatchGate(args(1), { db, github: github() });
    writeUsage(10);
    expect((await applyBuildDispatchGate(args(1), { db, github: github() })).decision).toBe("dispatch");
    expect(listUsageWaiting()).toEqual([]);
  });

  it("the dashboard override wins over config, and clearing it restores config", async () => {
    writeUsage(85);
    await db.setUsageOverride({ maxPercent: 95 }, "alice");
    expect((await applyBuildDispatchGate(args(1), { db, github: github() })).decision).toBe("dispatch");
    await db.clearUsageOverride();
    expect((await applyBuildDispatchGate(args(2), { db, github: github() })).decision).toBe("skip");
    await db.setUsageOverride({ enabled: false }, "alice");
    expect((await applyBuildDispatchGate(args(3), { db, github: github() })).decision).toBe("dispatch");
  });

  it("works without an emitter (no webhooks configured)", async () => {
    configureUsageGate({ emitter: null, now: () => now, botName: "last-light" });
    writeUsage(85);
    expect((await applyBuildDispatchGate(args(1), { db, github: github() })).decision).toBe("skip");
    expect(await heldRows()).toHaveLength(1);
  });
});
