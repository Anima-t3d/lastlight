/** The dispatcher's in-process `build-merge` branch: no workflow, no kill switch, never throws. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventEnvelope } from "#src/connectors/types.js";
import type { Route } from "#src/engine/router.js";

const { evaluate } = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock("#src/engine/build-merge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/engine/build-merge.js")>();
  return { ...actual, evaluateBuildMerge: evaluate };
});

import { dispatch, type DispatchDeps } from "#src/engine/dispatcher.js";
import { setRuntimeConfig, resetRuntimeConfigForTests, type LastLightConfig } from "#src/config/config.js";

function envelope(): EventEnvelope {
  return {
    id: "evt-1",
    source: "github",
    type: "pr.checks_passed",
    repo: "acme/widgets",
    prNumber: 31,
    isDependencyPr: false,
    sender: "github-actions[bot]",
    senderIsBot: false,
    body: "",
    raw: {},
    reply: vi.fn().mockResolvedValue(undefined),
    timestamp: new Date(),
  };
}

const route: Route = {
  action: "handler",
  handler: "build-merge",
  context: { repo: "acme/widgets", prNumber: 31, headSha: "b0b0", trigger: "checks-settled" },
};

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    db: { isWorkflowEnabled: vi.fn().mockResolvedValue(false) } as any,
    github: { tag: "gh" } as any,
    dispatchWorkflow: vi.fn(),
    sessionManager: {} as any,
    runChat: vi.fn(),
    route: vi.fn().mockResolvedValue(route),
    ...over,
  };
}

beforeEach(() => {
  evaluate.mockReset();
  setRuntimeConfig({ botLogin: "last-light[bot]" } as unknown as LastLightConfig);
});
afterEach(() => resetRuntimeConfigForTests());

describe("dispatch — build-merge handler", () => {
  it("evaluates the PR in process (checks-settled), with no workflow dispatch", async () => {
    evaluate.mockResolvedValue({ decision: "wait", reason: "checks-pending: x" });
    const d = deps();
    const outcome = await dispatch(envelope(), d);
    expect(outcome).toEqual({ kind: "handled", handler: "build-merge" });
    expect(evaluate).toHaveBeenCalledWith(
      { github: d.github, db: d.db, botLogin: "last-light[bot]" },
      "acme/widgets",
      31,
      "checks-settled",
    );
    expect(d.dispatchWorkflow).not.toHaveBeenCalled();
    // In-process: the admin workflow kill switch is not consulted.
    expect(d.db.isWorkflowEnabled).not.toHaveBeenCalled();
  });

  it("swallows an evaluation error — the sweep is the retry", async () => {
    evaluate.mockRejectedValue(new Error("502"));
    const outcome = await dispatch(envelope(), deps());
    expect(outcome).toEqual({ kind: "handled", handler: "build-merge" });
  });

  it("skips without a GitHub client", async () => {
    const outcome = await dispatch(envelope(), deps({ github: null }));
    expect(outcome.kind).toBe("skipped");
    expect(evaluate).not.toHaveBeenCalled();
  });
});
