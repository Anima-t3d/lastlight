/**
 * L3 escalation, the model half: an escalated build attempt runs its `executor`
 * and reviewer-`fix` phases on `models["executor-retry"]` /
 * `models["fix-retry"]`, through the same substitution the fix family's
 * `pr-fix-retry` uses. Attempt 1, and any deployment with no `-retry` key, is
 * untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));

import { executeAgent, executeCommand } from "#src/engine/agent-executor.js";
import { makeTestDb } from "../helpers/state-db.js";
import { escalateBuildModels, escalateFixModel, runSimpleWorkflow } from "#src/workflows/simple.js";
import { defaultFixConfig, type BuildConfig, type ModelConfig } from "#src/config/config.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";
import type { StateDb } from "#src/state/db.js";

const BASE = "anthropic/claude-sonnet-5-5";
const EXEC = "anthropic/claude-sonnet-5-5-exec";
const FIX = "anthropic/claude-sonnet-5-5-fix";
const EXEC_RETRY = "xiaomi/mimo-2.6-pro";
const FIX_RETRY = "xiaomi/mimo-2.6-pro-fix";
const BUILD: BuildConfig = { escalateAfterAttempt: 1, maxAttempts: 2 };

describe("escalateBuildModels — executor/fix → -retry above build.escalateAfterAttempt", () => {
  const withRetry: ModelConfig = {
    default: BASE,
    executor: EXEC,
    fix: FIX,
    "executor-retry": EXEC_RETRY,
    "fix-retry": FIX_RETRY,
  };

  it("attempt 1 is unchanged, by identity", () => {
    expect(escalateBuildModels(withRetry, 1, BUILD)).toBe(withRetry);
    expect(escalateBuildModels(withRetry, undefined, BUILD)).toBe(withRetry);
  });

  it("attempt 2 uses both retry models", () => {
    const out = escalateBuildModels(withRetry, 2, BUILD);
    expect(out?.executor).toBe(EXEC_RETRY);
    expect(out?.fix).toBe(FIX_RETRY);
    // Never mutates the map it was handed.
    expect(withRetry.executor).toBe(EXEC);
  });

  it("an unset -retry key keeps the original model (unset = today's behaviour)", () => {
    const none: ModelConfig = { default: BASE, executor: EXEC, fix: FIX };
    expect(escalateBuildModels(none, 2, BUILD)).toBe(none);
    const execOnly: ModelConfig = { default: BASE, executor: EXEC, fix: FIX, "executor-retry": EXEC_RETRY };
    const out = escalateBuildModels(execOnly, 2, BUILD);
    expect(out?.executor).toBe(EXEC_RETRY);
    expect(out?.fix).toBe(FIX);
  });

  it("honours escalateAfterAttempt 0 (from attempt 1) and a higher threshold", () => {
    expect(escalateBuildModels(withRetry, 1, { ...BUILD, escalateAfterAttempt: 0 })?.executor).toBe(EXEC_RETRY);
    expect(escalateBuildModels(withRetry, 2, { ...BUILD, escalateAfterAttempt: 2 })).toBe(withRetry);
  });

  it("the fix family's substitution still works through the shared helper", () => {
    const fixModels: ModelConfig = { default: BASE, "pr-fix-retry": EXEC_RETRY };
    expect(escalateFixModel("pr-fix", fixModels, 1, defaultFixConfig())?.["pr-fix"]).toBe(EXEC_RETRY);
    expect(escalateFixModel("pr-fix", fixModels, 0, defaultFixConfig())).toBe(fixModels);
  });
});

describe("build — the escalated models reach a real run's context", () => {
  let db: StateDb;
  let runId = "";
  let issueNumber = 100;

  beforeEach(async () => {
    db = await makeTestDb();
    runId = "";
    issueNumber += 1;
    // Fail the very first phase: the models are persisted at run creation,
    // which is all this asserts.
    vi.mocked(executeAgent).mockResolvedValue({ success: false, output: "", error: "stop here", turns: 0, durationMs: 1 });
    vi.mocked(executeCommand).mockResolvedValue({ success: false, output: "", error: "stop here", turns: 0, durationMs: 1 });
  });
  afterEach(() => vi.clearAllMocks());

  function config(): ExecutorConfig {
    return {
      model: BASE,
      maxTurns: 3,
      stateDir: "/tmp",
      sandboxDir: "/tmp/sandboxes",
      sessionsDir: "/tmp/sessions",
      sandbox: "none",
      buildAssets: "repo",
      buildAssetsDir: "/tmp/build-assets",
    };
  }

  async function run(extra: Record<string, unknown>, models: ModelConfig) {
    await runSimpleWorkflow(
      "build",
      { owner: "acme", repo: "widgets", issueNumber, issueTitle: "Add a toggle", sender: "alice", extra },
      config(),
      { onRunStart: async (id: string) => { runId = id; } },
      db,
      models,
      {},
      "lastlight:bootstrap",
      {},
    );
    return db.runs.getRun(runId);
  }

  const models: ModelConfig = { default: BASE, executor: EXEC, fix: FIX, "executor-retry": EXEC_RETRY, "fix-retry": FIX_RETRY };

  it("attempt 2 persists the retry models", async () => {
    const row = await run({ _stage: "build", _attempt: 2 }, models);
    const m = row?.context?.models as ModelConfig | undefined;
    expect(m?.executor).toBe(EXEC_RETRY);
    expect(m?.fix).toBe(FIX_RETRY);
  });

  it("attempt 1 persists the operator's models", async () => {
    const row = await run({ _stage: "build", _attempt: 1 }, models);
    const m = row?.context?.models as ModelConfig | undefined;
    expect(m?.executor).toBe(EXEC);
    expect(m?.fix).toBe(FIX);
  });
});
