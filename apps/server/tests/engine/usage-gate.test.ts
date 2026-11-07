import { describe, expect, it, vi } from "vitest";
import { evaluateUsage, readUsageSnapshot, type UsageSnapshot } from "#src/engine/usage-gate.js";

const now = new Date("2026-11-07T10:00:00Z");
const settings = {
  maxPercent: 80,
  windows: ["five_hour", "weekly"],
  staleAfterSeconds: 600,
  onUnavailable: "allow" as const,
  enabled: true,
};
function snap(windows: UsageSnapshot["windows"], updatedAt = "2026-11-07T09:58:00Z") {
  return { ok: true as const, snapshot: { updatedAt, windows } };
}
const w = (id: string, usedPct: number, resetsAt: string | null = "2026-11-07T13:00:00Z", provider = "commandcode") => ({
  provider,
  id,
  usedPct,
  resetsAt,
});

describe("evaluateUsage", () => {
  it("holds when a listed window is at or above maxPercent, naming it and its reset", () => {
    const v = evaluateUsage(snap([w("five_hour", 85), w("weekly", 20)]), settings, now);
    expect(v.held).toBe(true);
    if (!v.held) return;
    expect(v.window).toEqual(w("five_hour", 85));
    expect(v.maxPercent).toBe(80);
    expect(v.reason).toContain("five_hour");
    expect(v.reason).toContain("2026-11-07T13:00:00Z");
    expect(v.reason).toContain("85%");
  });

  it("holds at exactly maxPercent", () => {
    expect(evaluateUsage(snap([w("weekly", 80)]), settings, now).held).toBe(true);
  });

  it("does not hold below the threshold", () => {
    expect(evaluateUsage(snap([w("five_hour", 79)]), settings, now).held).toBe(false);
  });

  it("treats a window whose reset has passed as reset", () => {
    expect(evaluateUsage(snap([w("five_hour", 99, "2026-11-07T09:59:00Z")]), settings, now).held).toBe(false);
  });

  it("holds a window with no known reset", () => {
    expect(evaluateUsage(snap([w("weekly", 90, null)]), settings, now).held).toBe(true);
  });

  it("holds on the highest window across providers", () => {
    const v = evaluateUsage(snap([w("five_hour", 82), w("weekly", 95, null, "claude")]), settings, now);
    expect(v.held && v.window).toEqual(w("weekly", 95, null, "claude"));
  });

  it("ignores window ids that are not listed", () => {
    expect(evaluateUsage(snap([w("monthly", 100)]), settings, now).held).toBe(false);
  });

  it("clamps usedPct into 0–100", () => {
    const high = evaluateUsage(snap([w("five_hour", 140)]), settings, now);
    expect(high.held && high.window.usedPct).toBe(100);
    expect(evaluateUsage(snap([w("five_hour", -5)]), { ...settings, maxPercent: 1 }, now).held).toBe(false);
  });

  it("stale data is unavailable: allow lets it through with a reason", () => {
    const v = evaluateUsage(snap([w("five_hour", 99)], "2026-11-07T09:40:00Z"), settings, now);
    expect(v).toEqual({ held: false, reason: expect.stringContaining("usage data stale") });
  });

  it("stale data is unavailable: hold holds with that reason", () => {
    const v = evaluateUsage(snap([w("five_hour", 10)], "2026-11-07T09:40:00Z"), { ...settings, onUnavailable: "hold" }, now);
    expect(v.held).toBe(true);
    expect(v.reason).toContain("usage data stale");
    expect(v.held && v.window).toBeUndefined();
  });

  it("data dated more than a minute in the future is unavailable", () => {
    const r = evaluateUsage(snap([{ provider: "example", id: "five_hour", usedPct: 10, resetsAt: null }], "2026-11-07T10:05:00Z"), settings, now);
    expect(r).toEqual({ held: false, reason: "usage data unavailable: updatedAt is in the future" });
    const ok = evaluateUsage(snap([{ provider: "example", id: "five_hour", usedPct: 10, resetsAt: null }], "2026-11-07T10:00:30Z"), settings, now);
    expect(ok).toEqual({ held: false });
  });

  it("a failed read is unavailable", () => {
    expect(evaluateUsage({ ok: false, reason: "no file" }, settings, now)).toEqual({
      held: false,
      reason: "usage data unavailable: no file",
    });
    const held = evaluateUsage({ ok: false, reason: "no file" }, { ...settings, onUnavailable: "hold" }, now);
    expect(held.held).toBe(true);
    expect(held.reason).toBe("usage data unavailable: no file");
  });

  it("never holds when disabled", () => {
    expect(evaluateUsage(snap([w("five_hour", 100)]), { ...settings, enabled: false }, now).held).toBe(false);
    expect(evaluateUsage({ ok: false, reason: "x" }, { ...settings, enabled: false, onUnavailable: "hold" }, now).held).toBe(
      false,
    );
  });
});

describe("readUsageSnapshot", () => {
  const good = JSON.stringify({ updatedAt: "2026-11-07T09:58:00Z", windows: [w("five_hour", 42)] });

  it("reads the contract from a file", async () => {
    const readFile = vi.fn(async () => good);
    const r = await readUsageSnapshot({ file: "/run/x/usage.json" }, { readFile });
    expect(r).toEqual({ ok: true, snapshot: JSON.parse(good) });
    expect(readFile).toHaveBeenCalledWith("/run/x/usage.json");
  });

  it("a missing file is unavailable", async () => {
    const readFile = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    });
    const r = await readUsageSnapshot({ file: "/nope" }, { readFile });
    expect(r.ok).toBe(false);
  });

  it("malformed JSON is unavailable", async () => {
    expect((await readUsageSnapshot({ file: "/x" }, { readFile: async () => "{not json" })).ok).toBe(false);
  });

  it("a wrong shape is unavailable", async () => {
    for (const body of [
      "[]",
      JSON.stringify({ windows: [] }),
      JSON.stringify({ updatedAt: "not a date", windows: [] }),
      JSON.stringify({ updatedAt: "2026-11-07T09:58:00Z", windows: "x" }),
    ]) {
      expect((await readUsageSnapshot({ file: "/x" }, { readFile: async () => body })).ok).toBe(false);
    }
  });

  it("drops malformed windows but keeps the good ones", async () => {
    const body = JSON.stringify({
      updatedAt: "2026-11-07T09:58:00Z",
      windows: [w("five_hour", 42), { id: "weekly" }, { provider: "x", id: "weekly", usedPct: "high", resetsAt: null }, 7],
    });
    const r = await readUsageSnapshot({ file: "/x" }, { readFile: async () => body });
    expect(r.ok && r.snapshot.windows).toEqual([w("five_hour", 42)]);
  });

  it("refuses an oversized file", async () => {
    const r = await readUsageSnapshot({ file: "/x" }, { readFile: async () => good + " ".repeat(70_000) });
    expect(r.ok).toBe(false);
  });

  it("runs a command as argv, no shell, and reads its stdout", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: good }));
    const r = await readUsageSnapshot({ command: ["/usr/bin/usage", "--json"] }, { exec, timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith(["/usr/bin/usage", "--json"], 5000);
  });

  it("a failing command is unavailable", async () => {
    const r = await readUsageSnapshot({ command: ["/usr/bin/usage"] }, { exec: async () => ({ code: 1, stdout: good }) });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("exited 1") });
  });

  it("a command that throws (timeout, missing binary) is unavailable", async () => {
    const r = await readUsageSnapshot(
      { command: ["/usr/bin/usage"] },
      {
        exec: async () => {
          throw new Error("timed out");
        },
      },
    );
    expect(r.ok).toBe(false);
  });

  it("no source is unavailable", async () => {
    expect(await readUsageSnapshot(null)).toEqual({ ok: false, reason: "no usage source configured" });
  });
});
