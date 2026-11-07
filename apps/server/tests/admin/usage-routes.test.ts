import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AdminConfig } from "#src/admin/routes.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";
import { makeTestDb } from "../helpers/state-db.js";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: () => noopLogger };
  return { logger: () => noopLogger };
});
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
  getHostStats: vi.fn(async () => null),
}));
vi.mock("#src/sandbox/k8s/client.js", () => ({ makeK8sApis: vi.fn(() => ({}) as unknown) }));

const { createAdminRoutes } = await import("#src/admin/routes.js");
const { loadConfig, resetRuntimeConfigForTests } = await import("#src/config/config.js");
const { configureUsageGate, noteUsageHold, resetUsageGateForTests } = await import("#src/engine/usage-runtime.js");

/**
 * `GET /usage`, `POST /usage/settings`, `DELETE /usage/override` — the
 * dashboard Usage panel's API. The override follows the cron-override pattern:
 * config is the default, a row wins, DELETE reverts.
 */
describe("usage routes", () => {
  let db: StateDb;
  let dir: string;
  let usageFile: string;
  const now = new Date("2026-11-07T10:00:00Z");

  function app() {
    return createAdminRoutes(db, {} as unknown as SessionReader, {} as unknown as SessionReader, {
      stateDir: "/tmp",
      sessionsDir: "/tmp/sessions",
      adminPassword: "",
      adminSecret: "test-secret",
    } as AdminConfig);
  }
  const get = async () => {
    const res = await app().fetch(new Request("http://localhost/usage"));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const post = async (body: unknown) => {
    const res = await app().fetch(
      new Request("http://localhost/usage/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  function useConfig(usage: string) {
    writeFileSync(join(dir, "config.yaml"), `autonomy:\n  budget:\n${usage}`);
    loadConfig();
  }

  beforeEach(async () => {
    db = await makeTestDb();
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) vi.stubEnv(k, "");
    dir = mkdtempSync(join(tmpdir(), "usage-routes-"));
    usageFile = join(dir, "usage.json");
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", dir);
    useConfig(`    usage:\n      source: { file: ${usageFile} }\n`);
    writeFileSync(
      usageFile,
      JSON.stringify({
        updatedAt: "2026-11-07T09:59:00Z",
        windows: [{ provider: "commandcode", id: "five_hour", usedPct: 85, resetsAt: "2026-11-07T13:00:00Z" }],
      }),
    );
    configureUsageGate({ now: () => now });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
    resetUsageGateForTests();
  });

  it("GET reports the snapshot, the settings, the verdict, the waiting issues and recent holds", async () => {
    await noteUsageHold(db, { repo: "acme/widgets", issueNumber: 4, workflow: "build" }, {
      held: true,
      window: { provider: "commandcode", id: "five_hour", usedPct: 85, resetsAt: "2026-11-07T13:00:00Z" },
      maxPercent: 80,
      reason: "commandcode five_hour at 85% ≥ 80%",
    });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.snapshot.windows[0]).toMatchObject({ id: "five_hour", usedPct: 85 });
    expect(body.unavailableReason).toBeNull();
    expect(body.settings.effective).toMatchObject({ enabled: true, maxPercent: 80, windows: ["five_hour", "weekly"] });
    expect(body.settings.config.maxPercent).toBe(80);
    expect(body.settings.override).toBeNull();
    expect(body.verdict.held).toBe(true);
    expect(body.waiting).toEqual([{ repo: "acme/widgets", issueNumber: 4, since: now.toISOString() }]);
    expect(body.recentHolds).toHaveLength(1);
    expect(body.recentHolds[0]).toMatchObject({ targetId: "acme/widgets#4" });
  });

  it("never exposes the source path or command", async () => {
    const { body } = await get();
    expect(JSON.stringify(body)).not.toContain(usageFile);
    expect(body.settings.effective.source).toBe("file");
  });

  it("GET with no source says the gate is not configured", async () => {
    useConfig("    dailyUsd: 25\n");
    const { body } = await get();
    expect(body.configured).toBe(false);
    expect(body.snapshot).toBeNull();
    expect(body.verdict).toBeNull();
  });

  it("GET reports unavailable data with its reason", async () => {
    writeFileSync(usageFile, "{broken");
    const { body } = await get();
    expect(body.snapshot).toBeNull();
    expect(body.unavailableReason).toMatch(/not JSON/);
  });

  it("POST maxPercent overrides config; DELETE reverts", async () => {
    let r = await post({ maxPercent: 95 });
    expect(r.status).toBe(200);
    expect(r.body.settings.effective.maxPercent).toBe(95);
    expect(r.body.settings.override).toMatchObject({ maxPercent: 95, enabled: null });
    expect(r.body.verdict.held).toBe(false);

    const del = await app().fetch(new Request("http://localhost/usage/override", { method: "DELETE" }));
    expect(del.status).toBe(200);
    const after = (await del.json()) as Record<string, any>;
    expect(after.settings.override).toBeNull();
    expect(after.settings.effective.maxPercent).toBe(80);
    expect(after.verdict.held).toBe(true);

    r = await post({ enabled: false });
    expect(r.body.settings.effective.enabled).toBe(false);
    expect(r.body.verdict.held).toBe(false);
  });

  it("records each change in the activity log", async () => {
    await post({ maxPercent: 90 });
    await app().fetch(new Request("http://localhost/usage/override", { method: "DELETE" }));
    const rows = (await db.activity.list({ action: "config.edit" })).activity.filter((r) => r.targetType === "usage-gate");
    expect(rows).toHaveLength(2);
  });

  it("refuses a bad maxPercent or enabled, and an empty patch", async () => {
    for (const body of [{ maxPercent: 0 }, { maxPercent: 101 }, { maxPercent: "x" }, { maxPercent: 50.5 }, { enabled: "yes" }, {}]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(await db.getUsageOverride()).toBeNull();
  });
});
