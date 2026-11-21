/**
 * The autonomous merge executor: one evaluation of one build PR, against a real
 * run store and a fake GitHub that models the PR's state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import {
  evaluateBuildMerge,
  configureBuildMerge,
  MERGE_DECISIONS_SCRATCH_KEY,
} from "#src/engine/build-merge.js";
import { BUILD_REVIEW_SCRATCH_KEY } from "#src/engine/build-review.js";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  setMergeReposOverride,
  setAutonomyReposOverride,
  type LastLightConfig,
} from "#src/config/config.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";

const BOT = "last-light[bot]";
const REPO = "acme/widgets";
const PR = 12;
const ISSUE = 3;

function config(onMerge: "gate" | "none" = "gate"): LastLightConfig {
  return {
    autonomy: {
      repos: [REPO],
      stages: {
        "ready-for-agent": { enter: "ready-for-agent", workflow: "build", gates: {}, on_merge: onMerge },
      },
      budget: {},
    },
  } as unknown as LastLightConfig;
}

/** A GitHub fake whose PR is a mutable object, so a merge is visible to the next read. */
function fakeGithub(over: { files?: string[] | null; mergeOutcome?: string; labels?: string[] } = {}) {
  const pr = {
    number: PR,
    state: "open",
    merged: false,
    draft: false,
    title: "feat: widgets",
    body: "Closes #3",
    user: { login: BOT },
    head: { sha: "B", ref: "lastlight/3-widgets", repo: { full_name: REPO } },
    base: { ref: "main", repo: { full_name: REPO } },
    labels: (over.labels ?? []).map((name) => ({ name })),
    mergeable_state: "clean",
  };
  const gh = {
    pr,
    getPullRequest: vi.fn(async () => structuredClone(pr)),
    listPullRequestClosingIssues: vi.fn(async () => [{ number: ISSUE, title: "", body: "", url: "", state: "OPEN" }]),
    getChecksSummary: vi.fn(async () => ({ state: "passing", settledCount: 2, pendingCount: 0 })),
    listAllPullRequestFilePaths: vi.fn(async () => (over.files === undefined ? ["src/a.ts"] : over.files)),
    getDefaultBranch: vi.fn(async () => "main"),
    postComment: vi.fn(async () => 1),
    mergePullRequest: vi.fn(async () => {
      // Yield, so a concurrent evaluation would get the chance to overlap.
      await new Promise((r) => setTimeout(r, 5));
      const outcome = over.mergeOutcome ?? "merged";
      if (outcome === "merged") {
        pr.state = "closed";
        pr.merged = true;
        return { outcome: "merged", sha: "SQUASHSHA" };
      }
      return { outcome, message: "nope" };
    }),
  };
  return gh;
}

async function seedBuildRun(
  db: StateDb,
  over: { id?: string; context?: Record<string, unknown>; review?: Record<string, unknown> | null; issue?: number } = {},
): Promise<string> {
  const id = over.id ?? "run-1";
  await db.runs.createRun({
    id,
    workflowName: "build",
    triggerId: `${REPO}#${over.issue ?? ISSUE}`,
    owner: "acme",
    repo: "widgets",
    issueNumber: over.issue ?? ISSUE,
    currentPhase: "pr",
    status: "running",
    context: over.context ?? { _stage: "ready-for-agent", _autonomous: true, branch: "lastlight/3-widgets" },
    startedAt: new Date().toISOString(),
  });
  await db.runs.finishRun(id, "succeeded");
  if (over.review !== null) {
    await db.runs.mergeScratch(id, {
      [BUILD_REVIEW_SCRATCH_KEY]: {
        prNumber: PR,
        reviewedSha: "B",
        verdict: "APPROVED",
        verdictUrl: "https://dash/verdict",
        recordedAt: "2026-11-22T00:00:00.000Z",
        ...(over.review ?? {}),
      },
    });
  }
  return id;
}

async function ledger(db: StateDb, id = "run-1"): Promise<any[]> {
  const run = await db.runs.getRun(id);
  return ((run?.scratch ?? {})[MERGE_DECISIONS_SCRATCH_KEY] as any[]) ?? [];
}

const emit = vi.fn();

beforeEach(() => {
  setRuntimeConfig(config());
  setAutonomyReposOverride([REPO]);
  setMergeReposOverride([REPO]);
  emit.mockReset();
  configureBuildMerge({ emitter: { emit }, botName: "last-light" });
});

afterEach(() => {
  resetRuntimeConfigForTests();
  setMergeReposOverride(null);
  configureBuildMerge({ emitter: null });
});

describe("evaluateBuildMerge — merge path", () => {
  it("squash-merges at the REVIEWED head, comments once, records the outcome and emits run.merged", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "checks-settled");

    expect(res).toMatchObject({ decision: "merge", outcome: "merged" });
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(github.mergePullRequest).toHaveBeenCalledWith("acme", "widgets", PR, { sha: "B", method: "squash" });

    expect(github.postComment).toHaveBeenCalledTimes(1);
    const body = github.postComment.mock.calls[0][3] as string;
    expect(body).toContain("https://dash/verdict");
    expect(body).toContain("SQUASHSHA");

    const entries = await ledger(db);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      trigger: "checks-settled",
      decision: "merge",
      headSha: "B",
      outcome: "merged",
      commented: true,
    });
    expect(entries[0].reason).toMatch(/^clean:/);

    expect(emit).toHaveBeenCalledTimes(1);
    const [payload, repo] = emit.mock.calls[0];
    expect(repo).toBe(REPO);
    expect(payload.type).toBe("run.merged");
    expect(payload.merge).toMatchObject({ prNumber: PR, sha: "SQUASHSHA" });
    expect(payload.run).toMatchObject({ id: "run-1", workflow: "build", repo: REPO });
  });

  it("head-moved: no comment, no event, outcome recorded", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub({ mergeOutcome: "head-moved" });
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(res).toMatchObject({ decision: "merge", outcome: "head-moved" });
    expect(github.postComment).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect((await ledger(db))[0]).toMatchObject({ outcome: "head-moved" });
    expect((await ledger(db))[0].commented).toBeUndefined();
  });

  it("not-mergeable: one comment the first time; the same head is not PUT or commented again", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub({ mergeOutcome: "not-mergeable" });
    github.mergePullRequest.mockImplementation(async () => ({
      outcome: "not-mergeable",
      message: "Squash merges are not allowed on this `repo`\n@team",
    }));
    const deps = { github: github as any, db, botLogin: BOT };

    const first = await evaluateBuildMerge(deps, REPO, PR, "checks-settled");
    expect(first).toMatchObject({ decision: "hand-off", outcome: "not-mergeable" });
    expect(first.reason).toMatch(/^not-mergeable:/);
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(github.postComment).toHaveBeenCalledTimes(1);
    const body = github.postComment.mock.calls[0][3] as string;
    // GitHub's message only inside the sanitised code span.
    expect(body).toContain("`Squash merges are not allowed on this 'repo''@team`");
    expect(emit).not.toHaveBeenCalled();

    const again = await evaluateBuildMerge(deps, REPO, PR, "sweep");
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    expect(again.decision).toBe("hand-off");
    expect(again.reason).toMatch(/^not-mergeable:/);
    expect(again.outcome).toBeUndefined();
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(github.postComment).toHaveBeenCalledTimes(1);

    // A new push is a new head: one fresh attempt (stale review aside, the
    // record is re-pinned here to model a re-reviewed head).
    github.pr.head.sha = "C";
    await db.runs.mergeScratch("run-1", {
      [BUILD_REVIEW_SCRATCH_KEY]: {
        prNumber: PR, reviewedSha: "C", verdict: "APPROVED", verdictUrl: "https://dash/verdict", recordedAt: "t",
      },
    });
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    expect(github.mergePullRequest).toHaveBeenCalledTimes(2);
    expect(github.mergePullRequest).toHaveBeenLastCalledWith("acme", "widgets", PR, { sha: "C", method: "squash" });
    expect(github.postComment).toHaveBeenCalledTimes(2);
  });

  it("not-mergeable whose comment failed is commented on the next evaluation, still without a PUT", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub({ mergeOutcome: "not-mergeable" });
    github.postComment.mockRejectedValueOnce(new Error("502"));
    const deps = { github: github as any, db, botLogin: BOT };
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(github.postComment).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["getPullRequest"],
    ["getChecksSummary"],
    ["getDefaultBranch"],
    ["listAllPullRequestFilePaths"],
    ["listPullRequestClosingIssues"],
  ] as const)("a rejected %s read propagates: no merge, no comment, no merge entry", async (method) => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    (github[method] as any).mockRejectedValueOnce(Object.assign(new Error(`${method} 403`), { status: 403 }));
    await expect(
      evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "checks-settled"),
    ).rejects.toThrow(`${method} 403`);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
    expect((await ledger(db)).some((e) => e.decision === "merge")).toBe(false);
  });

  it("already-merged: no comment, no event", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub({ mergeOutcome: "already-merged" });
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(res.outcome).toBe("already-merged");
    expect(github.postComment).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("a merged PR is not merged or commented on again", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    const deps = { github: github as any, db, botLogin: BOT };
    await evaluateBuildMerge(deps, REPO, PR, "checks-settled");
    const again = await evaluateBuildMerge(deps, REPO, PR, "sweep");
    expect(again.decision).toBe("wait");
    expect(again.reason).toMatch(/^not-open:/);
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("two concurrent evaluations of one PR merge it at most once", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    const deps = { github: github as any, db, botLogin: BOT };
    const [a, b] = await Promise.all([
      evaluateBuildMerge(deps, REPO, PR, "checks-settled"),
      evaluateBuildMerge(deps, REPO, PR, "build-finished"),
    ]);
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
    expect([a.outcome, b.outcome].filter((o) => o === "merged")).toHaveLength(1);
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("a merge call that throws propagates and records nothing as merged", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    github.mergePullRequest.mockRejectedValueOnce(Object.assign(new Error("Bad credentials"), { status: 401 }));
    await expect(
      evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep"),
    ).rejects.toThrow("Bad credentials");
    expect(github.postComment).not.toHaveBeenCalled();
    expect((await ledger(db)).some((e) => e.outcome === "merged")).toBe(false);
  });
});

describe("evaluateBuildMerge — hand-off", () => {
  it("paths-unknown (null file list) never calls merge, and hands off", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub({ files: null });
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(res.decision).toBe("hand-off");
    expect(res.reason).toMatch(/^paths-unknown:/);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("comments once per (case, head) across repeated evaluations", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub({ labels: ["do-not-merge"] });
    const deps = { github: github as any, db, botLogin: BOT };
    await evaluateBuildMerge(deps, REPO, PR, "checks-settled");
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    expect(github.postComment).toHaveBeenCalledTimes(1);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    const body = github.postComment.mock.calls[0][3] as string;
    expect(body).toContain("hold-label");

    // A new head is a new problem: the same case comments again.
    github.pr.head.sha = "C";
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    expect(github.postComment).toHaveBeenCalledTimes(2);
    const entries = await ledger(db);
    expect(entries.map((e) => [e.headSha, e.commented ?? false])).toEqual([
      ["B", true],
      ["C", true],
    ]);
  });

  it("renders the reason inside inline code, so PR-supplied path text cannot mention or format", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub({ files: [".github/`@team` x.yml"] });
    await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    const body = github.postComment.mock.calls[0][3] as string;
    expect(body).toContain("`protected-path: .github/'@team' x.yml is protected`");
  });

  it("a failed hand-off comment is retried on the next evaluation", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub({ labels: ["do-not-merge"] });
    github.postComment.mockRejectedValueOnce(new Error("502"));
    const deps = { github: github as any, db, botLogin: BOT };
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    expect(github.postComment).toHaveBeenCalledTimes(2);
  });
});

describe("evaluateBuildMerge — waits and the ledger", () => {
  it("records a wait once while nothing changes, and never comments", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    github.getChecksSummary.mockResolvedValue({ state: "pending", settledCount: 0, pendingCount: 2 });
    const deps = { github: github as any, db, botLogin: BOT };
    const res = await evaluateBuildMerge(deps, REPO, PR, "checks-settled");
    await evaluateBuildMerge(deps, REPO, PR, "sweep");
    expect(res.decision).toBe("wait");
    expect(res.reason).toMatch(/^checks-pending:/);
    expect(await ledger(db)).toHaveLength(1);
    expect(github.postComment).not.toHaveBeenCalled();
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("keeps the last 50 entries", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const old = Array.from({ length: 50 }, (_, i) => ({
      at: "t", trigger: "sweep", decision: "wait", reason: `checks-pending: ${i}`, headSha: "A",
    }));
    await db.runs.mergeScratch("run-1", { [MERGE_DECISIONS_SCRATCH_KEY]: old });
    const github = fakeGithub();
    github.getChecksSummary.mockResolvedValue({ state: "pending", settledCount: 0, pendingCount: 1 });
    await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    const entries = await ledger(db);
    expect(entries).toHaveLength(50);
    expect(entries[0].reason).toBe("checks-pending: 1");
    expect(entries[49]).toMatchObject({ headSha: "B", decision: "wait" });
  });

  it("does nothing for a repo not on both lists — no reads at all", async () => {
    setMergeReposOverride([]);
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(res.decision).toBe("wait");
    expect(res.reason).toMatch(/^merge-disabled:/);
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("a merge-listed repo that is not on the autonomy list does nothing either", async () => {
    setAutonomyReposOverride([]);
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(res.reason).toMatch(/^merge-disabled:/);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("no build run recorded this PR → wait (not-from-build), nothing merged or recorded", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db, { review: { prNumber: 99 } });
    const github = fakeGithub();
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(res.decision).toBe("wait");
    expect(res.reason).toMatch(/^not-from-build:/);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
    expect(await ledger(db)).toEqual([]);
  });

  it("a PR that closes no issue has no build run → wait", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    github.listPullRequestClosingIssues.mockResolvedValue([]);
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(res.reason).toMatch(/^not-from-build:/);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("a human-asked build (no stage on its context) is not merge-enabled", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db, { context: { branch: "lastlight/3-widgets" } });
    const github = fakeGithub();
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(res.reason).toMatch(/^merge-disabled:/);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("a stage whose on_merge is not gate does not merge", async () => {
    setRuntimeConfig(config("none"));
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(res.reason).toMatch(/^merge-disabled:/);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("a PR another user opened is not ours, even with a matching record", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    github.pr.user.login = "mallory";
    const res = await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(res.reason).toMatch(/^not-ours:/);
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  it("reads checks strictly and excludes our own review check", async () => {
    const db = await makeTestDb();
    await seedBuildRun(db);
    const github = fakeGithub();
    await evaluateBuildMerge({ github: github as any, db, botLogin: BOT }, REPO, PR, "sweep");
    expect(github.getChecksSummary).toHaveBeenCalledWith("acme", "widgets", "B", {
      excludeApp: "last-light",
      strict: true,
    });
  });
});

describe("module boundaries", () => {
  it("the router does not statically import the executor (and its pr-state/sandbox chain)", () => {
    const src = readFileSync(join(__dirname, "../../src/engine/router.ts"), "utf8");
    expect(src).not.toMatch(/from "\.\/build-merge\.js"/);
  });
});
