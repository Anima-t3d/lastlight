/**
 * The Usage panel's pure readers: which state the panel is in, one row per
 * window with its threshold marker, the data age, and the threshold input.
 */
import { describe, it, expect } from "vitest";
import type { UsageView } from "../src/api";
import { dataAge, parseMaxPercent, recentHoldRows, resetsIn, usageRows, usageState } from "../src/lib/usage-view";

const NOW = new Date("2026-11-07T10:00:00Z");

function view(over: Partial<UsageView> = {}): UsageView {
  const settings = {
    source: "file" as const,
    enabled: true,
    maxPercent: 80,
    windows: ["five_hour", "weekly"],
    staleAfterSeconds: 600,
    onUnavailable: "allow" as const,
  };
  return {
    configured: true,
    snapshot: {
      updatedAt: "2026-11-07T09:58:00Z",
      windows: [
        { provider: "commandcode", id: "five_hour", usedPct: 42, resetsAt: "2026-11-07T13:00:00Z" },
        { provider: "commandcode", id: "weekly", usedPct: 12.5, resetsAt: null },
        { provider: "commandcode", id: "monthly", usedPct: 99, resetsAt: null },
      ],
    },
    unavailableReason: null,
    settings: { effective: settings, config: settings, override: null },
    verdict: { held: false },
    waiting: [],
    recentHolds: [],
    ...over,
  };
}

describe("usageState", () => {
  it("not configured", () => {
    expect(usageState(view({ configured: false, snapshot: null, verdict: null }), NOW)).toEqual({ kind: "not-configured" });
  });

  it("open", () => {
    expect(usageState(view(), NOW)).toEqual({ kind: "open" });
  });

  it("disabled by the switch", () => {
    const v = view();
    v.settings.effective = { ...v.settings.effective, enabled: false };
    expect(usageState(v, NOW)).toEqual({ kind: "disabled" });
  });

  it("holding since the oldest waiting issue", () => {
    const s = usageState(
      view({
        verdict: {
          held: true,
          maxPercent: 80,
          window: { provider: "commandcode", id: "five_hour", usedPct: 85.4, resetsAt: "2026-11-07T13:00:00Z" },
          reason: "commandcode five_hour at 85% ≥ 80%, resets 2026-11-07T13:00:00Z",
        },
        waiting: [
          { repo: "acme/a", issueNumber: 2, since: "2026-11-07T09:40:00Z" },
          { repo: "acme/a", issueNumber: 1, since: "2026-11-07T09:30:00Z" },
        ],
      }),
      NOW,
    );
    // The bars show the reset; the line names the window and the numbers only.
    expect(s).toEqual({ kind: "holding", since: "2026-11-07T09:30:00Z", reason: "commandcode five_hour at 85% (limit 80%)" });
  });

  it("unavailable shows the reason, not empty bars", () => {
    expect(usageState(view({ snapshot: null, unavailableReason: "usage data is not JSON", verdict: { held: false } }), NOW)).toEqual({
      kind: "unavailable",
      reason: "usage data is not JSON",
    });
  });

  it("stale data reads as unavailable with its age", () => {
    const v = view({ verdict: { held: false, reason: "usage data stale: updated 14 min ago (limit 10 min)" } });
    v.snapshot!.updatedAt = "2026-11-07T09:46:00Z";
    expect(usageState(v, NOW)).toEqual({ kind: "unavailable", reason: "usage data stale, updated 14 min ago" });
  });
});

describe("usageRows", () => {
  it("one row per listed window, with the threshold marker and the over flag", () => {
    const rows = usageRows(view({ snapshot: { updatedAt: "2026-11-07T09:58:00Z", windows: [
      { provider: "commandcode", id: "five_hour", usedPct: 85, resetsAt: "2026-11-07T13:00:00Z" },
      { provider: "claude", id: "weekly", usedPct: 140, resetsAt: null },
      { provider: "commandcode", id: "monthly", usedPct: 99, resetsAt: null },
    ] } }));
    expect(rows).toEqual([
      { key: "commandcode/five_hour", provider: "commandcode", window: "five_hour", usedPct: 85, thresholdPct: 80, over: true, resetsAt: "2026-11-07T13:00:00Z" },
      { key: "claude/weekly", provider: "claude", window: "weekly", usedPct: 100, thresholdPct: 80, over: true, resetsAt: null },
    ]);
  });

  it("uses the effective (overridden) threshold", () => {
    const v = view();
    v.settings.effective = { ...v.settings.effective, maxPercent: 40 };
    expect(usageRows(v)[0]).toMatchObject({ thresholdPct: 40, over: true });
  });

  it("no rows without a snapshot", () => {
    expect(usageRows(view({ snapshot: null }))).toEqual([]);
  });
});

describe("dataAge", () => {
  it("reads minutes, hours, and just now", () => {
    expect(dataAge("2026-11-07T09:59:40Z", NOW)).toBe("updated just now");
    expect(dataAge("2026-11-07T09:46:00Z", NOW)).toBe("updated 14 min ago");
    expect(dataAge("2026-11-07T07:00:00Z", NOW)).toBe("updated 3 h ago");
    expect(dataAge("garbage", NOW)).toBe("");
  });
});

describe("parseMaxPercent", () => {
  it("accepts an integer from 1 to 100 only", () => {
    expect(parseMaxPercent("90")).toBe(90);
    expect(parseMaxPercent(" 1 ")).toBe(1);
    expect(parseMaxPercent("100")).toBe(100);
    for (const bad of ["0", "101", "50.5", "", "x", "-3"]) expect(parseMaxPercent(bad)).toBeNull();
  });
});

describe("resetsIn", () => {
  it("reads the time left until a reset", () => {
    expect(resetsIn("2026-11-07T10:20:00Z", NOW)).toBe("resets in 20 min");
    expect(resetsIn("2026-11-07T13:05:00Z", NOW)).toBe("resets in 3 h 5 min");
    expect(resetsIn("2026-11-09T12:00:00Z", NOW)).toBe("resets in 2 d 2 h");
    expect(resetsIn("2026-11-07T09:00:00Z", NOW)).toBe("reset");
    expect(resetsIn(null, NOW)).toBe("");
  });
});

describe("recentHoldRows", () => {
  it("newest first, at most five, each naming the issue, window, usage and reset", () => {
    const holds = Array.from({ length: 7 }, (_, i) => ({
      id: `a${i}`,
      createdAt: `2026-11-07T0${i}:00:00Z`,
      targetId: `acme/a#${i}`,
      detail: { case: "usage-held", provider: "example", window: "five_hour", usedPct: 80 + i, resetsAt: "2026-11-07T13:00:00Z" },
    }));
    const rows = recentHoldRows(view({ recentHolds: holds }));
    expect(rows.map((r) => r.key)).toEqual(["a6", "a5", "a4", "a3", "a2"]);
    expect(rows[0]).toEqual({ key: "a6", at: "2026-11-07T06:00:00Z", issue: "acme/a#6", what: "example five_hour at 86%" });
  });

  it("a hold on unavailable data has no window", () => {
    const rows = recentHoldRows(
      view({ recentHolds: [{ id: "x", createdAt: "2026-11-07T09:00:00Z", targetId: "acme/a#1", detail: { case: "usage-held", reason: "usage-held: usage data stale" } }] }),
    );
    expect(rows).toEqual([{ key: "x", at: "2026-11-07T09:00:00Z", issue: "acme/a#1", what: "usage data unavailable" }]);
  });
});
