/**
 * An autonomous stage build keeps the approval policy it was created with on
 * every later start: the admission promotion of a run queued at the
 * concurrency cap, and the re-dispatch after a human approves a gate.
 *
 * The stage's gates (`_autonomyGates`) and the per-repo Approvals toggle
 * (`approval-skip-repos`) used to be read only on a fresh start in
 * `runSimpleWorkflow`. Admission enters through `resumeSimpleRun`, which handed
 * the runner the operator map alone, and the approval re-dispatch carries a
 * fresh context with no `_autonomyGates`, so a queued or approved stage build
 * in a repo NOT on the skip list ran past gates it should have paused at.
 *
 * Real code on every hop: `runSimpleWorkflow` queues the run, the real
 * admission controller promotes it through the real `resumeSimpleRun`, the
 * real runner decides the gates, and the approval re-enters through
 * `resolveGateAndResume` + `runSimpleWorkflow` exactly as the dispatcher's
 * `approval-response` handler does. Only the sandbox executor is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));

import { executeAgent } from "#src/engine/agent-executor.js";
import {
  defaultDependenciesConfig,
  defaultFixConfig,
  defaultNotificationsConfig,
  defaultReviewConfig,
  getRuntimeConfig,
  loadConfig,
  resetRuntimeConfigForTests,
  setAutonomyReposOverride,
  setMergeReposOverride,
  setRuntimeConfig,
  type LastLightConfig,
} from "#src/config/config.js";
import { resetApprovalSkipReposForTests, setStoredApprovalSkipRepos } from "#src/approval-skip-repos.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import { clearWorkflowCache, configureWorkflowAssets } from "#src/workflows/loader.js";
import { runSimpleWorkflow, type RunRepoConfig } from "#src/workflows/simple.js";
import { createAdmissionController } from "#src/workflows/admission.js";
import type { ResumeOptions } from "#src/workflows/resume.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";

const mockExecuteAgent = vi.mocked(executeAgent);

const REPO = "acme/widgets";
const STAGE_GATES = { post_architect: true, post_reviewer: true };
/** What the build gate stamps on an autonomous stage dispatch. */
const STAGE_BUILD = { _stage: "build", _autonomous: true, _autonomyGates: STAGE_GATES };
/** What the dispatcher's `approval-response` handler puts on the re-dispatch. */
const APPROVAL_REDISPATCH = { _triggerType: "approval" };

const BUILD_YAML = `
kind: build
name: build
phases:
  - name: architect
    label: Architect
    prompt: prompts/architect.md
    approval_gate: post_architect
  - name: reviewer
    label: Reviewer
    prompt: prompts/reviewer.md
    approval_gate: post_reviewer
  - name: pr
    label: PR
    prompt: prompts/pr.md
    approval_gate: pre_pr
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

/** A repo layer as `resolveRepoRunConfig` hands it over, with the operator's empty map. */
function repoLayer(): RunRepoConfig {
  return {
    repo: REPO,
    defaultBranch: "main",
    treeSha: "deadbeefcafe",
    fetchedAt: "2026-11-22T00:00:00.000Z",
    assets: [],
    models: { default: "anthropic/operator-default" },
    variants: {},
    approval: {},
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    fix: defaultFixConfig(),
    dependencies: defaultDependenciesConfig(),
    review: defaultReviewConfig(),
    notifications: defaultNotificationsConfig(),
    sources: {
      models: { default: "default" },
      variants: {},
      disabled: {
        workflows: "default",
        crons: "default",
        prompts: "default",
        skills: "default",
        agentContext: "default",
      },
      approval: {},
      fix: {},
      dependencies: {},
      review: {},
      notifications: {},
    },
    warnings: [],
  };
}

describe("a stage build keeps its creation-time approval policy across queue and approval", () => {
  let db: StateDb;
  let issue = 10;

  beforeEach(async () => {
    const builtIn = mkdtempSync(join(tmpdir(), "lastlight-stage-approval-"));
    mkdirSync(join(builtIn, "workflows", "prompts"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "build.yaml"), BUILD_YAML);
    for (const p of ["architect", "reviewer", "pr"]) {
      // Each prompt renders the run's merge policy, so a test can read what
      // `{{autonomyMerge.gate}}` resolved to on whichever start ran the phase.
      writeFileSync(join(builtIn, "workflows", "prompts", `${p}.md`), `${p} gate={{autonomyMerge.gate}}`);
    }
    configureWorkflowAssets({ builtInRoot: builtIn });
    clearWorkflowCache();
    db = await makeTestDb();
    setAutonomyReposOverride([REPO]);
    mockExecuteAgent.mockResolvedValue({ success: true, output: "done", error: undefined, turns: 1, durationMs: 1 });
  });

  afterEach(() => {
    configureWorkflowAssets();
    clearWorkflowCache();
    resetApprovalSkipReposForTests();
    setAutonomyReposOverride(null);
    setMergeReposOverride(null);
    resetRuntimeConfigForTests();
    vi.clearAllMocks();
  });

  const resumeOpts = (operatorApproval: Record<string, boolean>): ResumeOptions => ({
    db,
    github: null,
    config: makeConfig(),
    models: { default: "anthropic/operator-default" },
    variants: {},
    approvalConfig: operatorApproval,
  });

  /** One `runSimpleWorkflow` call for this test's issue, as `dispatchWorkflow` makes it. */
  function dispatch(
    extra: Record<string, unknown>,
    operatorApproval: Record<string, boolean>,
    maxWorkflows: number,
    repoConfig?: RunRepoConfig,
  ) {
    return runSimpleWorkflow(
      "build",
      {
        owner: "acme",
        repo: "widgets",
        issueNumber: issue,
        issueTitle: "Add a rate limiter",
        sender: "alice",
        extra,
        repoConfig,
      },
      makeConfig(),
      {},
      db,
      { default: "anthropic/operator-default" },
      operatorApproval,
      "lastlight:bootstrap",
      {},
      { maxWorkflows, maxQueueWaitMs: 60 * 60 * 1000 },
    );
  }

  /** Dispatch at a full cap (so the run is created `queued`); its id. */
  async function queueBuild(
    extra: Record<string, unknown>,
    operatorApproval: Record<string, boolean>,
    repoConfig?: RunRepoConfig,
  ): Promise<string> {
    issue++;
    const result = await dispatch(extra, operatorApproval, 0, repoConfig);
    expect(result.queued).toBe(true);
    const [run] = await db.runs.listQueued();
    return run!.id;
  }

  /** Promote it through the real admission controller and wait for it to stop. */
  async function admit(runId: string, operatorApproval: Record<string, boolean>): Promise<void> {
    const admission = createAdmissionController({
      db,
      resumeOpts: resumeOpts(operatorApproval),
      maxWorkflows: 1,
      maxQueueWaitMs: 60 * 60 * 1000,
    });
    await admission.admitNext();
    await vi.waitFor(async () => {
      const run = await db.runs.getRun(runId);
      expect(run?.status === "paused" || run?.status === "succeeded" || run?.status === "failed").toBe(true);
    });
  }

  /** Approve the pending gate and re-dispatch, as `handleApprovalResponse` does. */
  async function approveAndRedispatch(runId: string, operatorApproval: Record<string, boolean>): Promise<void> {
    const pending = await db.approvals.getPendingForWorkflow(runId);
    expect(pending).toBeTruthy();
    await db.runs.resolveGateAndResume(pending!.id, "alice");
    await dispatch(APPROVAL_REDISPATCH, operatorApproval, 1);
  }

  async function state(runId: string): Promise<{ status?: string; pending?: string }> {
    const run = await db.runs.getRun(runId);
    const pending = await db.approvals.getPendingForWorkflow(runId);
    return { status: run?.status, pending: pending?.status === "pending" ? pending.gate : undefined };
  }

  it("a skip-listed repo's queued stage build, started from the queue, does not pause at post_architect", async () => {
    setStoredApprovalSkipRepos({ repos: [REPO] });
    const runId = await queueBuild(STAGE_BUILD, {});
    await admit(runId, {});
    expect(await state(runId)).toEqual({ status: "succeeded", pending: undefined });
  });

  it("an unlisted repo's queued stage build pauses at post_architect, and after approval at post_reviewer", async () => {
    const runId = await queueBuild(STAGE_BUILD, {});
    await admit(runId, {});
    expect(await state(runId)).toEqual({ status: "paused", pending: "post_architect" });

    await approveAndRedispatch(runId, {});
    expect(await state(runId)).toEqual({ status: "paused", pending: "post_reviewer" });

    await approveAndRedispatch(runId, {});
    expect(await state(runId)).toEqual({ status: "succeeded", pending: undefined });
  });

  it("a direct (uncapped) stage build re-arms post_reviewer after its post_architect approval", async () => {
    issue++;
    await dispatch(STAGE_BUILD, {}, 5);
    const [run] = await db.runs.listRecent(1);
    expect(await state(run!.id)).toEqual({ status: "paused", pending: "post_architect" });
    await approveAndRedispatch(run!.id, {});
    expect(await state(run!.id)).toEqual({ status: "paused", pending: "post_reviewer" });
  });

  it("the skip list is read when the run is created: toggling it while queued does not change the run", async () => {
    // Created while NOT skipped → keeps the gates even if the repo is skip-listed before admission.
    const gated = await queueBuild(STAGE_BUILD, {});
    setStoredApprovalSkipRepos({ repos: [REPO] });
    await admit(gated, {});
    expect(await state(gated)).toEqual({ status: "paused", pending: "post_architect" });

    // Created while skipped → stays ungated even if the repo is un-skipped before admission.
    const ungated = await queueBuild(STAGE_BUILD, {});
    setStoredApprovalSkipRepos(null);
    await admit(ungated, {});
    expect(await state(ungated)).toEqual({ status: "succeeded", pending: undefined });
  });

  it("the stage gates survive a repo layer on the run (direct and queued start)", async () => {
    issue++;
    await dispatch(STAGE_BUILD, {}, 5, repoLayer());
    const [direct] = await db.runs.listRecent(1);
    expect(await state(direct!.id)).toEqual({ status: "paused", pending: "post_architect" });

    const queued = await queueBuild(STAGE_BUILD, {}, repoLayer());
    await admit(queued, {});
    expect(await state(queued)).toEqual({ status: "paused", pending: "post_architect" });
  });

  it("a human `@bot build` (no stage) is unchanged: only the operator's map gates it", async () => {
    setStoredApprovalSkipRepos({ repos: [REPO] });
    // No operator gates → runs straight through, queued or not.
    const open = await queueBuild({}, {});
    await admit(open, {});
    expect(await state(open)).toEqual({ status: "succeeded", pending: undefined });

    // The operator's post_architect applies (skip list or not); no stage gate is added after approval.
    const operator = { post_architect: true };
    const gated = await queueBuild({}, operator);
    await admit(gated, operator);
    expect(await state(gated)).toEqual({ status: "paused", pending: "post_architect" });
    await approveAndRedispatch(gated, operator);
    expect(await state(gated)).toEqual({ status: "succeeded", pending: undefined });
  });

  // ── The Approvals skip list turns the stage's gate names OFF (controller ruling) ──
  //
  // vps-sg sets `APPROVAL_GATES=post_architect,post_reviewer`, which makes both
  // stage gates OPERATOR gates too. A skip-listed repo's stage build must still
  // run without them, whichever layer turned them on; a human build keeps them,
  // and any other operator gate stays on.
  const ENV_GATES = { post_architect: true, post_reviewer: true };

  /** The prompts the stubbed executor was handed, phase name first. */
  const prompts = (): string[] => mockExecuteAgent.mock.calls.map((c) => String(c[0]));

  it("env-style operator gates + skip-listed repo: the stage build does not pause, direct or queued", async () => {
    setStoredApprovalSkipRepos({ repos: [REPO] });
    issue++;
    await dispatch(STAGE_BUILD, ENV_GATES, 5);
    const [direct] = await db.runs.listRecent(1);
    expect(await state(direct!.id)).toEqual({ status: "succeeded", pending: undefined });

    const queued = await queueBuild(STAGE_BUILD, ENV_GATES);
    await admit(queued, ENV_GATES);
    expect(await state(queued)).toEqual({ status: "succeeded", pending: undefined });
  });

  it("env-style operator gates + skip-listed repo: a human build still pauses at post_architect", async () => {
    setStoredApprovalSkipRepos({ repos: [REPO] });
    issue++;
    await dispatch({}, ENV_GATES, 5);
    const [direct] = await db.runs.listRecent(1);
    expect(await state(direct!.id)).toEqual({ status: "paused", pending: "post_architect" });

    const queued = await queueBuild({}, ENV_GATES);
    await admit(queued, ENV_GATES);
    expect(await state(queued)).toEqual({ status: "paused", pending: "post_architect" });
  });

  it("env-style operator gates + unlisted repo: the stage build pauses at both, re-armed after approval", async () => {
    const runId = await queueBuild(STAGE_BUILD, ENV_GATES);
    await admit(runId, ENV_GATES);
    expect(await state(runId)).toEqual({ status: "paused", pending: "post_architect" });
    await approveAndRedispatch(runId, ENV_GATES);
    expect(await state(runId)).toEqual({ status: "paused", pending: "post_reviewer" });
    await approveAndRedispatch(runId, ENV_GATES);
    expect(await state(runId)).toEqual({ status: "succeeded", pending: undefined });
  });

  it("skip-listed repo: an unrelated operator gate stays on, direct, queued and after approval", async () => {
    setStoredApprovalSkipRepos({ repos: [REPO] });
    const operator = { ...ENV_GATES, pre_pr: true };
    issue++;
    await dispatch(STAGE_BUILD, operator, 5);
    const [direct] = await db.runs.listRecent(1);
    expect(await state(direct!.id)).toEqual({ status: "paused", pending: "pre_pr" });

    const queued = await queueBuild(STAGE_BUILD, operator);
    await admit(queued, operator);
    expect(await state(queued)).toEqual({ status: "paused", pending: "pre_pr" });
    await approveAndRedispatch(queued, operator);
    expect(await state(queued)).toEqual({ status: "succeeded", pending: undefined });
  });

  // ── The merge policy (`autonomyMerge`) is the run's, not the start's ──

  /** Boot config with the build stage handing its PR to the merge gate. */
  function mergeGateConfig(): void {
    const base = getRuntimeConfig() ?? loadConfig();
    setRuntimeConfig({
      ...base,
      autonomy: {
        ...base.autonomy,
        repos: [REPO],
        stages: { build: { ...base.autonomy.stages.build, on_merge: "gate" } },
      },
    } as LastLightConfig);
    setMergeReposOverride([REPO]);
  }

  it("a queued stage build in a merge repo runs with autonomyMerge.gate on admission and after approval", async () => {
    mergeGateConfig();
    const runId = await queueBuild(STAGE_BUILD, {});
    await admit(runId, {});
    expect(await state(runId)).toEqual({ status: "paused", pending: "post_architect" });
    expect(prompts()).toEqual(["architect gate=true"]);
    // Persisted at creation: the run's own policy, whatever the Merges list says now.
    expect((await db.runs.getRun(runId))?.context?.autonomyMerge).toMatchObject({ effective: "gate", gate: true });

    setMergeReposOverride(null);
    await approveAndRedispatch(runId, {});
    await approveAndRedispatch(runId, {});
    expect(await state(runId)).toEqual({ status: "succeeded", pending: undefined });
    expect(prompts()).toEqual(["architect gate=true", "reviewer gate=true", "pr gate=true"]);
  });

  it("a human build in a merge repo has the inert merge policy, queued or resumed", async () => {
    mergeGateConfig();
    const operator = { post_architect: true };
    const runId = await queueBuild({}, operator);
    await admit(runId, operator);
    await approveAndRedispatch(runId, operator);
    expect(await state(runId)).toEqual({ status: "succeeded", pending: undefined });
    expect(prompts()).toEqual(["architect gate=false", "reviewer gate=false", "pr gate=false"]);
  });
});
