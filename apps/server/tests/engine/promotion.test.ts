/**
 * L2 — promote a queued issue when its blockers close.
 *
 * `resolvePromotion` is a pure table; the executors are driven with a fake
 * GitHub client. Fail-closed is the property under test: only a blocker that is
 * `closed` AND `completed` counts as done.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("#src/logging/logger.js", () => {
  const noop = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: () => noop };
  return { logger: () => noop };
});

import {
  resolvePromotion,
  promoteDependents,
  promoteReadyQueued,
} from "#src/engine/promotion.js";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  defaultAutonomyConfig,
  getHoldLabel,
  type LastLightConfig,
} from "#src/config/config.js";

const QUEUED = "lastlight:queued";
const CFG = { queuedLabel: QUEUED, autonomyEnabled: true };
const queued = { labels: [QUEUED], state: "open" as const };
const done = { state: "closed" as const, stateReason: "completed" };

describe("resolvePromotion", () => {
  it.each([
    ["not-queued", { labels: ["bug"], state: "open" as const }, [], CFG, "skip"],
    ["not-autonomous", queued, [], { ...CFG, autonomyEnabled: false }, "skip"],
    ["closed", { labels: [QUEUED], state: "closed" as const }, [], CFG, "skip"],
    ["no blockers", queued, [], CFG, "promote"],
    ["an open blocker", queued, [{ state: "open" as const, stateReason: null }], CFG, "wait"],
    ["all completed", queued, [done, done], CFG, "promote"],
    ["one not_planned", queued, [done, { state: "closed" as const, stateReason: "not_planned" }], CFG, "block"],
    ["closed with null reason", queued, [{ state: "closed" as const, stateReason: null }], CFG, "wait"],
    ["closed reopened-reason", queued, [{ state: "closed" as const, stateReason: "reopened" }], CFG, "wait"],
  ] as const)("%s -> %s", (name, issue, blockers, cfg, expected) => {
    const r = resolvePromotion(issue, blockers, cfg);
    expect(r.decision).toBe(expected);
    expect(r.reason).toMatch(/^[a-z-]+: /);
    if (expected === "skip") expect(r.reason.startsWith(name === "closed" ? "closed" : name)).toBe(true);
  });

  it("a blocker reopened AFTER promotion skips as not-queued (no demotion)", () => {
    // Promotion removed the queued label; the reopened blocker is open again.
    const r = resolvePromotion(
      { labels: ["ready-for-agent"], state: "open" },
      [{ state: "open", stateReason: "reopened" }],
      CFG,
    );
    expect(r.decision).toBe("skip");
    expect(r.reason.startsWith("not-queued")).toBe(true);
  });
});

type Dep = { number: number; state: "open" | "closed"; stateReason: "completed" | "not_planned" | "reopened" | null };

function fake(opts: {
  issues?: Record<number, { labels: string[]; state: "open" | "closed" }>;
  blockedBy?: Record<number, Dep[] | Error>;
  blocking?: Record<number, Dep[]>;
}) {
  const issues = opts.issues ?? {};
  return {
    getIssue: vi.fn(async (_o: string, _r: string, n: number) => ({
      number: n,
      state: issues[n].state,
      labels: issues[n].labels.map((name) => ({ name })),
    })),
    listIssueDependencies: vi.fn(async (_o: string, _r: string, n: number, kind: string) => {
      if (kind === "blocking") return opts.blocking?.[n] ?? [];
      const v = opts.blockedBy?.[n] ?? [];
      if (v instanceof Error) throw v;
      return v;
    }),
    listOpenIssuesByLabel: vi.fn(async () =>
      Object.entries(issues)
        .filter(([, i]) => i.state === "open" && i.labels.includes(QUEUED))
        .map(([n, i]) => ({ number: Number(n), title: "SECRET TITLE", labels: i.labels, createdAt: "" })),
    ),
    addLabels: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    postComment: vi.fn(async () => 1),
  };
}

beforeEach(() => {
  setRuntimeConfig({
    autonomy: { ...defaultAutonomyConfig(), repos: ["o/r"], queuedLabel: QUEUED },
  } as unknown as LastLightConfig);
});
afterEach(() => resetRuntimeConfigForTests());

const asDeps = (gh: ReturnType<typeof fake>) => ({ github: gh as never });

describe("promoteDependents", () => {
  it("promotes: moves queued -> ready-for-agent via advanceStage", async () => {
    const gh = fake({
      issues: { 7: { labels: [QUEUED], state: "open" } },
      blocking: { 1: [{ number: 7, state: "open", stateReason: null }] },
      blockedBy: { 7: [{ number: 1, state: "closed", stateReason: "completed" }] },
    });
    await promoteDependents(asDeps(gh), "o/r", 1);
    expect(gh.addLabels).toHaveBeenCalledWith("o", "r", 7, ["ready-for-agent"]);
    expect(gh.removeLabel).toHaveBeenCalledWith("o", "r", 7, QUEUED);
    expect(gh.postComment).not.toHaveBeenCalled();
  });

  it("waits while another blocker is still open", async () => {
    const gh = fake({
      issues: { 7: { labels: [QUEUED], state: "open" } },
      blocking: { 1: [{ number: 7, state: "open", stateReason: null }] },
      blockedBy: {
        7: [
          { number: 1, state: "closed", stateReason: "completed" },
          { number: 2, state: "open", stateReason: null },
        ],
      },
    });
    await promoteDependents(asDeps(gh), "o/r", 1);
    expect(gh.addLabels).not.toHaveBeenCalled();
  });

  it("blocks: moves to agent-blocked and posts ONE fixed comment naming the blocker, no title", async () => {
    const gh = fake({
      issues: { 7: { labels: [QUEUED], state: "open" } },
      blocking: { 1: [{ number: 7, state: "open", stateReason: null }] },
      blockedBy: { 7: [{ number: 1, state: "closed", stateReason: "not_planned" }] },
    });
    await promoteDependents(asDeps(gh), "o/r", 1);
    expect(gh.addLabels).toHaveBeenCalledWith("o", "r", 7, ["agent-blocked"]);
    expect(gh.removeLabel).toHaveBeenCalledWith("o", "r", 7, QUEUED);
    expect(gh.postComment).toHaveBeenCalledTimes(1);
    const body = gh.postComment.mock.calls[0][3] as string;
    expect(body).toContain("#1");
    expect(body).not.toContain("SECRET TITLE");
  });

  it("a dependency read that throws on one issue does not stop the others", async () => {
    const gh = fake({
      issues: { 7: { labels: [QUEUED], state: "open" }, 8: { labels: [QUEUED], state: "open" } },
      blocking: {
        1: [
          { number: 7, state: "open", stateReason: null },
          { number: 8, state: "open", stateReason: null },
        ],
      },
      blockedBy: { 7: new Error("boom"), 8: [{ number: 1, state: "closed", stateReason: "completed" }] },
    });
    await promoteDependents(asDeps(gh), "o/r", 1);
    expect(gh.addLabels).toHaveBeenCalledTimes(1);
    expect(gh.addLabels).toHaveBeenCalledWith("o", "r", 8, ["ready-for-agent"]);
  });

  it("a non-autonomy repo makes no GitHub calls", async () => {
    const gh = fake({});
    await promoteDependents(asDeps(gh), "x/y", 1);
    await promoteReadyQueued(asDeps(gh), "x/y");
    for (const fn of Object.values(gh)) expect(fn).not.toHaveBeenCalled();
  });

  it("a failing dependents listing is swallowed", async () => {
    const gh = fake({});
    gh.listIssueDependencies.mockRejectedValueOnce(new Error("down"));
    await expect(promoteDependents(asDeps(gh), "o/r", 1)).resolves.toBeUndefined();
  });
});

describe("hold and block safety", () => {
  const HOLD = "lastlight:hold";
  const base = (labels: string[], bb: Dep[]) =>
    fake({
      issues: { 7: { labels, state: "open" } },
      blocking: { 1: [{ number: 7, state: "open", stateReason: null }] },
      blockedBy: { 7: bb },
    });
  const completed: Dep = { number: 1, state: "closed", stateReason: "completed" };
  const notPlanned: Dep = { number: 1, state: "closed", stateReason: "not_planned" };

  it("resolvePromotion: held outranks promote and block", () => {
    const cfg = { ...CFG, holdLabel: HOLD };
    const issue = { labels: [QUEUED, HOLD], state: "open" as const };
    expect(resolvePromotion(issue, [done], cfg).reason.startsWith("held")).toBe(true);
    const np = resolvePromotion(issue, [{ state: "closed", stateReason: "not_planned" }], cfg);
    expect(np.decision).toBe("skip");
    expect(np.reason.startsWith("held")).toBe(true);
  });

  it("a held queued issue with all blockers completed is not promoted", async () => {
    const gh = base([QUEUED, getHoldLabel()], [completed]);
    await promoteDependents(asDeps(gh), "o/r", 1);
    expect(gh.addLabels).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
    expect(gh.postComment).not.toHaveBeenCalled();
  });

  it("a held issue with a not_planned blocker is not blocked and gets no comment", async () => {
    const gh = base([QUEUED, getHoldLabel()], [notPlanned]);
    await promoteDependents(asDeps(gh), "o/r", 1);
    expect(gh.addLabels).not.toHaveBeenCalled();
    expect(gh.postComment).not.toHaveBeenCalled();
  });

  it("block with add-failed posts no comment", async () => {
    const gh = base([QUEUED], [notPlanned]);
    gh.addLabels.mockRejectedValue(new Error("nope"));
    await promoteDependents(asDeps(gh), "o/r", 1);
    expect(gh.postComment).not.toHaveBeenCalled();
  });

  it("block with remove-failed posts no comment", async () => {
    const gh = base([QUEUED], [notPlanned]);
    gh.removeLabel.mockRejectedValue(new Error("nope"));
    await promoteDependents(asDeps(gh), "o/r", 1);
    expect(gh.postComment).not.toHaveBeenCalled();
  });

  it("two evaluations of a block whose advance keeps failing post zero comments", async () => {
    const gh = base([QUEUED], [notPlanned]);
    gh.addLabels.mockRejectedValue(new Error("nope"));
    await promoteDependents(asDeps(gh), "o/r", 1);
    await promoteDependents(asDeps(gh), "o/r", 1);
    expect(gh.postComment).not.toHaveBeenCalled();
  });

  it("an issue already at agent-blocked gets no second comment", async () => {
    const gh = base([QUEUED, "agent-blocked"], [notPlanned]);
    await promoteDependents(asDeps(gh), "o/r", 1);
    expect(gh.addLabels).not.toHaveBeenCalled();
    expect(gh.postComment).not.toHaveBeenCalled();
  });
});

describe("promoteReadyQueued", () => {
  it("evaluates every queued issue, continuing past a failure", async () => {
    const gh = fake({
      issues: { 7: { labels: [QUEUED], state: "open" }, 8: { labels: [QUEUED], state: "open" } },
      blockedBy: { 7: new Error("boom"), 8: [] },
    });
    await promoteReadyQueued(asDeps(gh), "o/r");
    expect(gh.addLabels).toHaveBeenCalledTimes(1);
    expect(gh.addLabels).toHaveBeenCalledWith("o", "r", 8, ["ready-for-agent"]);
  });

  it("a listing failure is swallowed", async () => {
    const gh = fake({});
    gh.listOpenIssuesByLabel.mockRejectedValueOnce(new Error("down"));
    await expect(promoteReadyQueued(asDeps(gh), "o/r")).resolves.toBeUndefined();
  });
});
