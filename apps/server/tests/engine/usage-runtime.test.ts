import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import { configureUsageGate, currentUsage, resetUsageGateForTests } from "#src/engine/usage-runtime.js";
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
