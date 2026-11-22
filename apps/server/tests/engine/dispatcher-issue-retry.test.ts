/**
 * `@bot retry [hint]` on a blocked issue, one step past the router: the
 * dispatcher hands the build stage's context to `dispatchWorkflow` intact —
 * `_stage` (so the build gate runs), `_buildRoute: "api"`, `_attempt: 1` and
 * the `_hint` — rather than through `handleBuild`, which rebuilds the context
 * field by field and would drop every one of them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventEnvelope } from "#src/connectors/types.js";
import type { Route } from "#src/engine/router.js";
import { dispatch, type DispatchDeps } from "#src/engine/dispatcher.js";
import { setRuntimeConfig, resetRuntimeConfigForTests, type LastLightConfig } from "#src/config/config.js";

function envelope(): EventEnvelope {
  return {
    id: "evt-retry",
    source: "github",
    type: "comment.created",
    repo: "acme/widgets",
    issueNumber: 42,
    sender: "maintainer",
    senderIsBot: false,
    body: "@last-light retry fix the import",
    raw: {},
    reply: vi.fn().mockResolvedValue(undefined),
    timestamp: new Date(),
  };
}

const route: Route = {
  action: "handler",
  handler: "build",
  context: {
    _routeKey: "github.issue_retry",
    _stage: "build",
    _buildRoute: "api",
    _senderIsBot: false,
    _attempt: 1,
    _hint: "fix the import",
    repo: "acme/widgets",
    issueNumber: 42,
    labels: ["agent-blocked"],
    sender: "maintainer",
  },
};

beforeEach(() => {
  setRuntimeConfig({ botLogin: "last-light[bot]" } as unknown as LastLightConfig);
});
afterEach(() => resetRuntimeConfigForTests());

describe("dispatch — @bot retry on a blocked issue", () => {
  it("dispatches the build with the stage, the api route, attempt 1 and the hint", async () => {
    const dispatchWorkflow = vi.fn().mockResolvedValue({ success: true });
    const deps: DispatchDeps = {
      db: {
        isWorkflowEnabled: vi.fn().mockResolvedValue(true),
        executions: { isRunning: vi.fn().mockResolvedValue(false) },
      } as any,
      github: null,
      dispatchWorkflow,
      sessionManager: {} as any,
      runChat: vi.fn(),
      route: vi.fn().mockResolvedValue(route),
    };

    const outcome = await dispatch(envelope(), deps);

    expect(outcome).toEqual({ kind: "dispatched", workflow: "build" });
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
    const [workflow, ctx] = dispatchWorkflow.mock.calls[0];
    expect(workflow).toBe("build");
    expect(ctx).toMatchObject({
      _stage: "build",
      _buildRoute: "api",
      _attempt: 1,
      _hint: "fix the import",
      repo: "acme/widgets",
      issueNumber: 42,
    });
    expect(ctx._routeKey).toBeUndefined();
  });
});
