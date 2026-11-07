import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import { configureUsageGate, currentUsage, listUsageWaiting, noteUsageHold, resetUsageGateForTests, usageVerdictForDispatch } from "#src/engine/usage-runtime.js";
import type { UsageVerdict } from "#src/engine/usage-gate.js";
import type { UsageReadResult } from "#src/engine/usage-gate.js";
import { makeTestDb } from "../helpers/state-db.js";
import type { StateDb } from "#src/state/db.js";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: () => noopLogger };
  return { logger: () => noopLogger };
});

/**
 * The usage read is bounded and shared: a stuck source cannot hang a caller,
 * a gate switched off reads nothing, and one read serves every caller for a
 * short while instead of one process per gated issue and per dashboard poll.
 */
describe("currentUsage — the read", () => {
  let db: StateDb;
  let dir: string;
  let now: Date;
  const snapshot: UsageReadResult = {
    ok: true,
    snapshot: {
      updatedAt: "2026-11-07T09:59:00Z",
      windows: [{ provider: "example", id: "five_hour", usedPct: 85, resetsAt: "2026-11-07T13:00:00Z" }],
    },
  };

  beforeEach(async () => {
    db = await makeTestDb();
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) vi.stubEnv(k, "");
    dir = mkdtempSync(join(tmpdir(), "usage-runtime-"));
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", dir);
    writeFileSync(join(dir, "config.yaml"), `autonomy:\n  budget:\n    usage:\n      source: { command: ["usage-cli"] }\n`);
    loadConfig();
    now = new Date("2026-11-07T10:00:00Z");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
    resetUsageGateForTests();
  });

  it("a source that never answers reads as unavailable after the time limit", async () => {
    configureUsageGate({ read: () => new Promise<UsageReadResult>(() => {}), readTimeoutMs: 30, now: () => now });
    const { read, verdict } = await currentUsage(db);
    expect(read).toEqual({ ok: false, reason: "usage source timed out" });
    expect(verdict).toMatchObject({ held: false });
  });

  it("does not read the source while the gate is switched off", async () => {
    const read = vi.fn(async () => snapshot);
    configureUsageGate({ read, now: () => now });
    await db.setUsageOverride({ enabled: false }, "alice");
    const { verdict } = await currentUsage(db);
    expect(read).not.toHaveBeenCalled();
    expect(verdict).toEqual({ held: false, reason: "usage gate disabled" });
  });

  it("one read serves every caller for the cache period, then the source is read again", async () => {
    const read = vi.fn(async () => snapshot);
    configureUsageGate({ read, cacheMs: 30_000, now: () => now });
    await Promise.all([currentUsage(db), currentUsage(db), currentUsage(db)]);
    expect(read).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 31_000);
    await currentUsage(db);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a threshold change applies at once, without waiting for the cache", async () => {
    configureUsageGate({ read: async () => snapshot, cacheMs: 30_000, now: () => now });
    expect((await currentUsage(db)).verdict?.held).toBe(true);
    await db.setUsageOverride({ maxPercent: 95 }, "alice");
    expect((await currentUsage(db)).verdict?.held).toBe(false);
  });
});

describe("noteUsageHold — announcing", () => {
  let db: StateDb;
  const now = new Date("2026-11-07T10:00:00Z");
  const subject = { repo: "acme/widgets", issueNumber: 4, workflow: "build" };
  const held = (resetsAt: string): Extract<UsageVerdict, { held: true }> => ({
    held: true,
    window: { provider: "example", id: "five_hour", usedPct: 85, resetsAt },
    maxPercent: 80,
    reason: "example five_hour at 85% ≥ 80%",
  });
  const rows = async () =>
    (await db.activity.list({ action: "autonomy.skip" })).activity.filter(
      (r) => (r.detail as { case?: string } | null)?.case === "usage-held",
    );

  beforeEach(async () => {
    db = await makeTestDb();
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) vi.stubEnv(k, "");
    const dir = mkdtempSync(join(tmpdir(), "usage-note-"));
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", dir);
    writeFileSync(join(dir, "config.yaml"), `autonomy:\n  budget:\n    usage:\n      source: { command: ["usage-cli"] }\n`);
    loadConfig();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
    resetUsageGateForTests();
  });

  it("the same reset, written with a different sub-minute precision, is one hold", async () => {
    configureUsageGate({ now: () => now });
    await noteUsageHold(db, subject, held("2026-11-07T13:00:00.123Z"));
    await noteUsageHold(db, subject, held("2026-11-07T13:00:00.987Z"));
    await noteUsageHold(db, subject, held("2026-11-07T13:00:59Z"));
    expect(await rows()).toHaveLength(1);
  });

  it("a hold noted after a later read found the gate open is not announced", async () => {
    let usedPct = 85;
    configureUsageGate({
      now: () => now,
      cacheMs: 0,
      read: async () => ({
        ok: true,
        snapshot: { updatedAt: "2026-11-07T09:59:00Z", windows: [{ provider: "example", id: "five_hour", usedPct, resetsAt: "2026-11-07T13:00:00Z" }] },
      }),
    });
    const first = await usageVerdictForDispatch(db);
    expect(first?.held).toBe(true);
    usedPct = 10;
    expect((await usageVerdictForDispatch(db))?.held).toBe(false);
    await noteUsageHold(db, subject, first as Extract<UsageVerdict, { held: true }>);
    expect(await rows()).toHaveLength(0);
    expect(listUsageWaiting()).toEqual([]);
  });
});
