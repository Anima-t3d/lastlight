/**
 * The per-repo Approvals toggle (`approval-skip-repos`): an autonomous stage
 * build in a repo on the skip list runs with no stage-added approval gates.
 *
 * The stage's `gates` reach the run on `_autonomyGates` (stamped at dispatch
 * by the build gate) and are unioned add-only onto the run's effective
 * approval map in `runSimpleWorkflow`. These tests read the map the runner is
 * handed, so they pin exactly which gates the run can pause at.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("#src/workflows/runner.js", async (orig) => ({
  ...(await orig<typeof import("#src/workflows/runner.js")>()),
  runWorkflow: vi.fn(async () => ({ success: true, phases: [] })),
}));

import { runWorkflow } from "#src/workflows/runner.js";
import { setAutonomyReposOverride, resetRuntimeConfigForTests } from "#src/config/config.js";
import { setStoredApprovalSkipRepos, resetApprovalSkipReposForTests } from "#src/approval-skip-repos.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import { configureWorkflowAssets, clearWorkflowCache } from "#src/workflows/loader.js";
import { runSimpleWorkflow } from "#src/workflows/simple.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";

const mockRunWorkflow = vi.mocked(runWorkflow);

const REPO = "acme/widgets";
const STAGE_GATES = { post_architect: true, post_reviewer: true };
/** What the build gate stamps on an autonomous stage dispatch. */
const STAGE_BUILD = { _stage: "build", _autonomous: true, _autonomyGates: STAGE_GATES };

const BUILD_YAML = `
kind: build
name: build
phases:
  - name: pr
    label: PR
    prompt: prompts/pr.md
`;

function makeConfig(): ExecutorConfig {
  return {
    model: "anthropic/operator-default",
    maxTurns: 3,
    stateDir: "/tmp",
    sandboxDir: "/tmp/sandboxes",
    sessionsDir: "/tmp/sessions",
    sandbox: "none",
    buildAssets: "repo",
    buildAssetsDir: "/tmp/build-assets",
  };
}

describe("the Approvals toggle reaches the run's effective approval map", () => {
  let db: StateDb;
  let issue = 0;

  beforeEach(async () => {
    const builtIn = mkdtempSync(join(tmpdir(), "lastlight-autonomy-approvals-"));
    mkdirSync(join(builtIn, "workflows", "prompts"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "build.yaml"), BUILD_YAML);
    writeFileSync(join(builtIn, "workflows", "prompts", "pr.md"), "open the PR");
    configureWorkflowAssets({ builtInRoot: builtIn });
    clearWorkflowCache();
    db = await makeTestDb();
    setAutonomyReposOverride([REPO]);
  });

  afterEach(() => {
    configureWorkflowAssets();
    clearWorkflowCache();
    resetApprovalSkipReposForTests();
    setAutonomyReposOverride(null);
    resetRuntimeConfigForTests();
    vi.clearAllMocks();
  });

  /** Run one build with `extra` and the operator's `approval:` map; the map the runner got. */
  async function approvalFor(
    extra: Record<string, unknown>,
    operatorApproval: Record<string, boolean> = {},
  ): Promise<Record<string, boolean> | undefined> {
    issue++;
    await runSimpleWorkflow(
      "build",
      { owner: "acme", repo: "widgets", issueNumber: issue, issueTitle: "Add a rate limiter", sender: "alice", extra },
      makeConfig(),
      {},
      db,
      { default: "anthropic/operator-default" },
      operatorApproval,
      "lastlight:bootstrap",
      {},
    );
    expect(mockRunWorkflow).toHaveBeenCalledTimes(1);
    return mockRunWorkflow.mock.calls[0]![6] as Record<string, boolean> | undefined;
  }

  it("an unlisted repo's stage build keeps both stage gates", async () => {
    expect(await approvalFor(STAGE_BUILD)).toEqual({ post_architect: true, post_reviewer: true });
  });

  it("a listed repo's stage build has no post_architect or post_reviewer gate", async () => {
    setStoredApprovalSkipRepos({ repos: [REPO] });
    const approval = await approvalFor(STAGE_BUILD);
    expect(approval?.post_architect).not.toBe(true);
    expect(approval?.post_reviewer).not.toBe(true);
  });

  it("a listed repo still keeps the operator's own approval map", async () => {
    setStoredApprovalSkipRepos({ repos: [REPO] });
    expect(await approvalFor(STAGE_BUILD, { post_reviewer: true })).toEqual({ post_reviewer: true });
  });

  it("an escalation retry in a listed repo has no stage gates", async () => {
    setStoredApprovalSkipRepos({ repos: [REPO] });
    const approval = await approvalFor({ ...STAGE_BUILD, _buildRoute: "escalation", _attempt: 2 });
    expect(approval?.post_architect).not.toBe(true);
    expect(approval?.post_reviewer).not.toBe(true);
  });

  it("an escalation retry in an unlisted repo keeps them", async () => {
    expect(await approvalFor({ ...STAGE_BUILD, _buildRoute: "escalation", _attempt: 2 })).toEqual(STAGE_GATES);
  });

  it("a human `@bot build` (no stage) is unaffected by the list", async () => {
    setStoredApprovalSkipRepos({ repos: [REPO] });
    expect(await approvalFor({}, { post_architect: true })).toEqual({ post_architect: true });
    mockRunWorkflow.mockClear();
    setStoredApprovalSkipRepos(null);
    expect(await approvalFor({}, { post_architect: true })).toEqual({ post_architect: true });
  });

  it("a skip entry for a repo no longer on the autonomy list does not skip", async () => {
    setStoredApprovalSkipRepos({ repos: [REPO] });
    setAutonomyReposOverride([]);
    expect(await approvalFor(STAGE_BUILD)).toEqual(STAGE_GATES);
  });
});
