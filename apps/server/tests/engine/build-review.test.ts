import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "#src/state/workflow-run-store.js";
import {
  BUILD_REVIEW_SCRATCH_KEY,
  captureWorkspaceHead,
  finalizeBuildReview,
  finalizeBuildReviewForRun,
  readWorkspaceHead,
  readBuildReview,
  recordBuildReview,
} from "#src/engine/build-review.js";
import { REVIEW_CHECK_NAME } from "#src/engine/review-check.js";
import { MERGE_DECISIONS_SCRATCH_KEY } from "#src/engine/build-merge-ledger.js";
import {
  resetRuntimeConfigForTests,
  setAutonomyReposOverride,
  setMergeReposOverride,
  setRuntimeConfig,
  type LastLightConfig,
} from "#src/config/config.js";
import { logger } from "#src/logging/logger.js";

// The merge executor is exercised in build-merge.test.ts; here only the hook's
// call is asserted, so it is replaced wholesale.
const { evaluateMerge } = vi.hoisted(() => ({
  evaluateMerge: vi.fn(async () => ({ decision: "wait", reason: "x: y" })),
}));
vi.mock("#src/engine/build-merge.js", () => ({ evaluateBuildMerge: evaluateMerge }));

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

function fakeDb() {
  const scratch: Record<string, unknown> = {};
  return {
    scratch,
    runs: {
      mergeScratch: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        Object.assign(scratch, patch);
      }),
      getRun: vi.fn(async (id: string) => ({ id, scratch: structuredClone(scratch) })),
    },
  } as any;
}

function pr(over: Record<string, any> = {}) {
  return {
    head: { ref: "lastlight/1-x", sha: "head-after-push", repo: { full_name: "o/r" } },
    base: { ref: "main" },
    user: { login: "last-light[bot]" },
    ...over,
  };
}

function fakeGithub(over: Record<string, unknown> = {}) {
  return {
    getPullRequest: vi.fn().mockResolvedValue(pr()),
    getDefaultBranch: vi.fn().mockResolvedValue("main"),
    createCheckRun: vi.fn().mockResolvedValue(7),
    postComment: vi.fn().mockResolvedValue(1),
    ...over,
  } as any;
}

const base = {
  runId: "run-1",
  owner: "o",
  repo: "r",
  prNumber: 12,
  verdictUrl: "https://dash/verdict",
  branch: "lastlight/1-x",
  reviewedHeadSha: "head-after-push",
};
const botDeps = { botLogin: "last-light[bot]" };

describe("finalizeBuildReview", () => {
  it("stores an APPROVED record pinned to the PR head and posts a success check there", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    const rec = await finalizeBuildReview({ ...base, approved: true }, { db, github, ...botDeps });
    expect(rec).toMatchObject({
      prNumber: 12, reviewedSha: "head-after-push", verdict: "APPROVED", verdictUrl: "https://dash/verdict",
    });
    expect(db.scratch[BUILD_REVIEW_SCRATCH_KEY]).toEqual(rec);
    expect(github.createCheckRun).toHaveBeenCalledWith(
      "o", "r", "head-after-push", REVIEW_CHECK_NAME,
      expect.objectContaining({
        status: "completed", conclusion: "success", detailsUrl: "https://dash/verdict",
      }),
    );
  });

  it("stores REQUEST_CHANGES (after on_max_cycles) and posts a failure check", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    const rec = await finalizeBuildReview({ ...base, approved: false }, { db, github, ...botDeps });
    expect(rec?.verdict).toBe("REQUEST_CHANGES");
    expect(github.createCheckRun).toHaveBeenCalledWith(
      "o", "r", "head-after-push", REVIEW_CHECK_NAME,
      expect.objectContaining({ conclusion: "failure" }),
    );
  });

  it("records nothing and never throws when the PR head cannot be read", async () => {
    const db = fakeDb();
    const github = fakeGithub({ getPullRequest: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(finalizeBuildReview({ ...base, approved: true }, { db, github, ...botDeps })).resolves.toBeNull();
    expect(db.runs.mergeScratch).not.toHaveBeenCalled();
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it("keeps the record when posting the check fails", async () => {
    const db = fakeDb();
    const github = fakeGithub({ createCheckRun: vi.fn().mockRejectedValue(new Error("403")) });
    const rec = await finalizeBuildReview({ ...base, approved: true }, { db, github, ...botDeps });
    expect(rec?.verdict).toBe("APPROVED");
    expect(db.scratch[BUILD_REVIEW_SCRATCH_KEY]).toEqual(rec);
  });

  it("does nothing without a PR or a GitHub client", async () => {
    const db = fakeDb();
    expect(await finalizeBuildReview({ ...base, prNumber: 0, approved: true }, { db, github: fakeGithub(), ...botDeps })).toBeNull();
    expect(await finalizeBuildReview({ ...base, approved: true }, { db, github: null, ...botDeps })).toBeNull();
    expect(db.runs.mergeScratch).not.toHaveBeenCalled();
  });
});

describe("finalizeBuildReview binds to the build's own PR and the reviewed commit", () => {
  const run = async (prOver: Record<string, any>, args: Record<string, any> = {}) => {
    const db = fakeDb();
    const github = fakeGithub({ getPullRequest: vi.fn().mockResolvedValue(pr(prOver)) });
    const rec = await finalizeBuildReview({ ...base, approved: true, ...args }, { db, github, ...botDeps });
    return { db, github, rec };
  };
  const nothing = ({ db, github, rec }: any) => {
    expect(rec).toBeNull();
    expect(db.runs.mergeScratch).not.toHaveBeenCalled();
    expect(github.createCheckRun).not.toHaveBeenCalled();
  };

  it("S1: head.ref differs from the run branch", async () => {
    nothing(await run({ head: { ref: "other", sha: "head-after-push", repo: { full_name: "o/r" } } }));
  });
  it("S1: fork head repo", async () => {
    nothing(await run({ head: { ref: "lastlight/1-x", sha: "head-after-push", repo: { full_name: "evil/r" } } }));
  });
  it("S1: author is not the bot", async () => {
    nothing(await run({ user: { login: "mallory" } }));
  });
  it("S1: base is not the default branch", async () => {
    nothing(await run({ base: { ref: "release" } }));
  });
  it("S1: unknown branch fails closed", async () => {
    nothing(await run({}, { branch: "" }));
  });
  it("S1: unknown bot login fails closed", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    expect(await finalizeBuildReview({ ...base, approved: true }, { db, github, botLogin: undefined })).toBeNull();
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });
  it("S2: approved and PR head equals the captured SHA -> recorded with it, success posted", async () => {
    const { rec, github } = await run({}, { reviewedHeadSha: "head-after-push" });
    expect(rec?.reviewedSha).toBe("head-after-push");
    expect(github.createCheckRun).toHaveBeenCalledWith(
      "o", "r", "head-after-push", REVIEW_CHECK_NAME, expect.objectContaining({ conclusion: "success" }),
    );
  });
  it("S2: approved but PR head moved past the captured SHA -> nothing", async () => {
    nothing(await run({}, { reviewedHeadSha: "reviewed-earlier" }));
  });
  it("S2: approved with no captured SHA -> nothing", async () => {
    nothing(await run({}, { reviewedHeadSha: undefined }));
  });
  it("S2: REQUEST_CHANGES is still recorded without a captured SHA", async () => {
    const { rec } = await run({}, { approved: false, reviewedHeadSha: undefined });
    expect(rec?.verdict).toBe("REQUEST_CHANGES");
  });
});

describe("readBuildReview / recordBuildReview", () => {
  const run = (scratch: unknown) => ({ id: "r", scratch } as unknown as WorkflowRun);
  const good = {
    prNumber: 3, reviewedSha: "abc", verdict: "APPROVED", verdictUrl: "u", recordedAt: "2026-11-22T00:00:00Z",
  };

  it("round-trips a stored record", async () => {
    const db = fakeDb();
    await recordBuildReview(db, "r", good as any);
    expect(readBuildReview(run(db.scratch))).toEqual(good);
  });

  it.each([
    ["absent", {}],
    ["null", { buildReview: null }],
    ["a string", { buildReview: "x" }],
    ["missing sha", { buildReview: { ...good, reviewedSha: undefined } }],
    ["bad verdict", { buildReview: { ...good, verdict: "MAYBE" } }],
    ["string prNumber", { buildReview: { ...good, prNumber: "3" } }],
    ["empty sha", { buildReview: { ...good, reviewedSha: "" } }],
  ])("returns null for malformed scratch (%s)", (_n, scratch) => {
    expect(readBuildReview(run(scratch))).toBeNull();
  });

  it("returns null when scratch itself is missing", () => {
    expect(readBuildReview({ id: "r" } as unknown as WorkflowRun)).toBeNull();
  });
});

describe("finalizeBuildReviewForRun", () => {
  const ctx = {
    owner: "o", repo: "r", branch: "lastlight/1-x", issueDir: ".lastlight/issue-1",
    externalizeArtifacts: true, publicUrl: "https://dash",
  } as any;
  const ok = { success: true, prNumber: 9, review: { approved: true, cycles: 0, headSha: "head-after-push" } };

  it("links the verdict artifact and records for a build that opened a PR", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    const rec = await finalizeBuildReviewForRun(
      { workflowName: "build", result: ok, ctx, runId: "run-1" },
      { db, github: () => github, ...botDeps },
    );
    expect(rec?.verdictUrl).toContain("doc=reviewer-verdict.md");
    expect(rec?.prNumber).toBe(9);
  });

  it.each([
    ["not a build", { workflowName: "pr-review", result: ok }],
    ["failed run", { workflowName: "build", result: { ...ok, success: false } }],
    ["paused run", { workflowName: "build", result: { ...ok, paused: true } }],
    ["no PR opened", { workflowName: "build", result: { ...ok, prNumber: undefined } }],
    ["no reviewer verdict", { workflowName: "build", result: { ...ok, review: undefined } }],
  ])("is a no-op for %s", async (_n, a) => {
    const db = fakeDb();
    const github = fakeGithub();
    expect(
      await finalizeBuildReviewForRun({ ...(a as any), ctx, runId: "run-1" }, { db, github: () => github, ...botDeps }),
    ).toBeNull();
    expect(github.getPullRequest).not.toHaveBeenCalled();
  });

  it("never throws when the client cannot be resolved", async () => {
    const db = fakeDb();
    const rec = await finalizeBuildReviewForRun(
      { workflowName: "build", result: ok, ctx, runId: "run-1" },
      { db, github: () => { throw new Error("no auth"); }, ...botDeps },
    );
    expect(rec).toBeNull();
  });
});

describe("readWorkspaceHead", () => {
  function checkout(root: string, taskDirName = "t1") {
    const repoDir = join(root, taskDirName, "r");
    mkdirSync(repoDir, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", repoDir, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repoDir, "f"), "x");
    git("add", "f");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    return { repoDir, git };
  }
  const tmp = () => mkdtempSync(join(tmpdir(), "bw-"));

  it("captures HEAD of a clean checkout", () => {
    const sandboxDir = tmp();
    const { git } = checkout(sandboxDir);
    expect(readWorkspaceHead({ sandboxDir }, "t1", "o", "r")).toBe(git("rev-parse", "HEAD"));
  });

  it("captures nothing when the checkout is missing", () => {
    expect(readWorkspaceHead({ sandboxDir: tmp() }, "t1", "o", "r")).toBeUndefined();
  });

  it("captures nothing when a tracked file is modified", () => {
    const sandboxDir = tmp();
    const { repoDir } = checkout(sandboxDir);
    writeFileSync(join(repoDir, "f"), "changed");
    expect(readWorkspaceHead({ sandboxDir }, "t1", "o", "r")).toBeUndefined();
  });

  it("captures nothing when an untracked file is present", () => {
    const sandboxDir = tmp();
    const { repoDir } = checkout(sandboxDir);
    writeFileSync(join(repoDir, "new"), "y");
    expect(readWorkspaceHead({ sandboxDir }, "t1", "o", "r")).toBeUndefined();
  });

  it("captures nothing when HEAD has no commit", () => {
    const sandboxDir = tmp();
    const repoDir = join(sandboxDir, "t1", "r");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["-C", repoDir, "init", "-q"]);
    expect(readWorkspaceHead({ sandboxDir }, "t1", "o", "r")).toBeUndefined();
  });

  it("never falls back to a pr-review workspace root", () => {
    const sandboxDir = tmp();
    // A clean repo at the workspace ROOT carrying `.lastlight/pr-review`: the
    // layout `resolveHostRepoDir` falls back to when `<root>/<repo>` is absent.
    const workDir = join(sandboxDir, "t1");
    mkdirSync(join(workDir, ".lastlight", "pr-review"), { recursive: true });
    execFileSync("git", ["-C", workDir, "init", "-q"]);
    writeFileSync(join(workDir, ".gitignore"), ".lastlight\n");
    execFileSync("git", ["-C", workDir, "add", ".gitignore"]);
    execFileSync("git", ["-C", workDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c"]);
    expect(readWorkspaceHead({ sandboxDir }, "t1", "o", "r")).toBeUndefined();
  });

  // The reasons logged by each call: exactly one per refusal, none on capture.
  function capture(sandboxDir: string) {
    const warn = vi.mocked(logger("t").warn);
    warn.mockClear();
    const sha = readWorkspaceHead({ sandboxDir }, "t1", "o", "r");
    return { sha, reasons: warn.mock.calls.map((c) => (c[1] as { reason?: string } | undefined)?.reason) };
  }
  const commit = (git: (...a: string[]) => string) =>
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c2");

  it("captures HEAD of a clean checkout with no warning", () => {
    const sandboxDir = tmp();
    const { git } = checkout(sandboxDir);
    expect(capture(sandboxDir)).toEqual({ sha: git("rev-parse", "HEAD"), reasons: [] });
  });

  it("refuses a checkout whose index holds a gitlink (submodule)", () => {
    const sandboxDir = tmp();
    const { git } = checkout(sandboxDir);
    git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},sub`);
    commit(git);
    expect(capture(sandboxDir)).toEqual({ sha: undefined, reasons: ["submodules"] });
  });

  it("refuses a checkout carrying a .git/modules directory", () => {
    const sandboxDir = tmp();
    const { repoDir } = checkout(sandboxDir);
    mkdirSync(join(repoDir, ".git", "modules", "sub"), { recursive: true });
    expect(capture(sandboxDir)).toEqual({ sha: undefined, reasons: ["submodules"] });
  });

  it("refuses a modified file hidden by assume-unchanged", () => {
    const sandboxDir = tmp();
    const { repoDir, git } = checkout(sandboxDir);
    git("update-index", "--assume-unchanged", "f");
    writeFileSync(join(repoDir, "f"), "changed");
    expect(git("status", "--porcelain")).toBe(""); // the hiding works on plain status
    expect(capture(sandboxDir)).toEqual({ sha: undefined, reasons: ["index-flags"] });
  });

  it("refuses a modified file hidden by skip-worktree", () => {
    const sandboxDir = tmp();
    const { repoDir, git } = checkout(sandboxDir);
    git("update-index", "--skip-worktree", "f");
    writeFileSync(join(repoDir, "f"), "changed");
    expect(git("status", "--porcelain")).toBe("");
    expect(capture(sandboxDir)).toEqual({ sha: undefined, reasons: ["index-flags"] });
  });

  it("refuses a file carrying both assume-unchanged and skip-worktree", () => {
    const sandboxDir = tmp();
    const { repoDir, git } = checkout(sandboxDir);
    git("update-index", "--assume-unchanged", "f");
    git("update-index", "--skip-worktree", "f");
    expect(git("ls-files", "-v")).toBe("s f");
    writeFileSync(join(repoDir, "f"), "changed");
    expect(capture(sandboxDir)).toEqual({ sha: undefined, reasons: ["index-flags"] });
  });

  it("still captures a clean checkout with an ignored untracked file", () => {
    const sandboxDir = tmp();
    const { repoDir, git } = checkout(sandboxDir);
    writeFileSync(join(repoDir, ".gitignore"), "scratch\n");
    git("add", ".gitignore");
    commit(git);
    writeFileSync(join(repoDir, "scratch"), "notes");
    expect(capture(sandboxDir)).toEqual({ sha: git("rev-parse", "HEAD"), reasons: [] });
  });

  // Temp index dirs readWorkspaceHead creates under os.tmpdir().
  const tempIndexDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("lastlight-review-index-"));

  it("refuses a modification hidden by a forged index entry (HEAD blob, current stat)", () => {
    const sandboxDir = tmp();
    const { repoDir, git } = checkout(sandboxDir);
    const headBlob = git("rev-parse", "HEAD:f");
    writeFileSync(join(repoDir, "f"), "changed");
    // Back-date the file so the entry is not "racily clean" against the index's own mtime.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repoDir, "f"), past, past);
    git("update-index", "f"); // the index now holds the new blob with the file's current stat
    const indexPath = join(repoDir, ".git", "index");
    const idx = readFileSync(indexPath);
    expect(idx.subarray(0, 4).toString()).toBe("DIRC");
    expect(idx.readUInt32BE(8)).toBe(1); // one entry, starting at byte 12; its object id at 12 + 40
    Buffer.from(headBlob, "hex").copy(idx, 52);
    createHash("sha1").update(idx.subarray(0, idx.length - 20)).digest().copy(idx, idx.length - 20);
    writeFileSync(indexPath, idx);
    expect(git("status", "--porcelain")).toBe(""); // the forgery hides the change from plain status
    expect(git("ls-files", "-v")).toBe("H f"); // and sets no index flag
    expect(capture(sandboxDir)).toEqual({ sha: undefined, reasons: ["dirty-tree"] });
  });

  it("removes its temp index after a capture and after a refusal", () => {
    const before = tempIndexDirs();
    const clean = tmp();
    const { git } = checkout(clean);
    expect(capture(clean)).toEqual({ sha: git("rev-parse", "HEAD"), reasons: [] });
    expect(tempIndexDirs()).toEqual(before);
    const dirty = tmp();
    writeFileSync(join(checkout(dirty).repoDir, "f"), "changed");
    expect(capture(dirty)).toEqual({ sha: undefined, reasons: ["dirty-tree"] });
    expect(tempIndexDirs()).toEqual(before);
  });

  it("refuses temp-index when HEAD's tree cannot be read into the temp index", () => {
    const before = tempIndexDirs();
    const sandboxDir = tmp();
    const { repoDir, git } = checkout(sandboxDir);
    const tree = git("rev-parse", "HEAD^{tree}");
    rmSync(join(repoDir, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    expect(capture(sandboxDir)).toEqual({ sha: undefined, reasons: ["temp-index"] });
    expect(tempIndexDirs()).toEqual(before);
  });
});

describe("finalizeBuildReviewForRun — the build-finished merge trigger", () => {
  const ctx = {
    owner: "o", repo: "r", branch: "lastlight/1-x", issueDir: ".lastlight/issue-1",
    externalizeArtifacts: true, publicUrl: "https://dash",
  } as any;
  const ok = { success: true, prNumber: 9, review: { approved: true, cycles: 0, headSha: "head-after-push" } };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    evaluateMerge.mockReset();
    evaluateMerge.mockResolvedValue({ decision: "wait", reason: "x: y" });
  });

  it("evaluates the PR for merge after an APPROVED record is written", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    const rec = await finalizeBuildReviewForRun(
      { workflowName: "build", result: ok, ctx, runId: "run-1" },
      { db, github: () => github, ...botDeps },
    );
    await vi.waitFor(() => expect(evaluateMerge).toHaveBeenCalled());
    expect(rec?.verdict).toBe("APPROVED");
    expect(evaluateMerge).toHaveBeenCalledTimes(1);
    expect(evaluateMerge).toHaveBeenCalledWith(
      { github, db, botLogin: "last-light[bot]" },
      "o/r",
      9,
      "build-finished",
    );
    // The record was already written when the evaluation started.
    expect(db.runs.mergeScratch.mock.invocationCallOrder[0]).toBeLessThan(
      evaluateMerge.mock.invocationCallOrder[0],
    );
  });

  it("does not evaluate after a REQUEST_CHANGES record", async () => {
    const db = fakeDb();
    await finalizeBuildReviewForRun(
      { workflowName: "build", result: { ...ok, review: { approved: false, headSha: "head-after-push" } }, ctx, runId: "run-1" },
      { db, github: () => fakeGithub(), ...botDeps },
    );
    await flush();
    expect(evaluateMerge).not.toHaveBeenCalled();
  });

  it("does not evaluate when no record was written (approval not bound to the PR head)", async () => {
    const db = fakeDb();
    const rec = await finalizeBuildReviewForRun(
      { workflowName: "build", result: { ...ok, review: { approved: true, headSha: "something-else" } }, ctx, runId: "run-1" },
      { db, github: () => fakeGithub(), ...botDeps },
    );
    await flush();
    expect(rec).toBeNull();
    expect(evaluateMerge).not.toHaveBeenCalled();
  });

  it("a failing evaluation never fails the hook", async () => {
    evaluateMerge.mockRejectedValue(new Error("boom"));
    const db = fakeDb();
    const rec = await finalizeBuildReviewForRun(
      { workflowName: "build", result: ok, ctx, runId: "run-1" },
      { db, github: () => fakeGithub(), ...botDeps },
    );
    await vi.waitFor(() => expect(evaluateMerge).toHaveBeenCalled());
    await flush();
    expect(rec?.verdict).toBe("APPROVED");
  });
});

describe("captureWorkspaceHead names the refusal", () => {
  it("returns the sha of a clean checkout", () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "bw-"));
    const repoDir = join(sandboxDir, "t1", "r");
    mkdirSync(repoDir, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", repoDir, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repoDir, "f"), "x");
    git("add", "f");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    expect(captureWorkspaceHead({ sandboxDir }, "t1", "o", "r")).toEqual({ sha: git("rev-parse", "HEAD") });
    writeFileSync(join(repoDir, "f"), "dirty");
    expect(captureWorkspaceHead({ sandboxDir }, "t1", "o", "r")).toEqual({ refused: "dirty-tree" });
  });

  it("returns no-checkout when there is no checkout", () => {
    expect(captureWorkspaceHead({ sandboxDir: mkdtempSync(join(tmpdir(), "bw-")) }, "t1", "o", "r")).toEqual({
      refused: "no-checkout",
    });
  });
});

describe("finalizeBuildReviewForRun — a gate run whose approval cannot be recorded (I4a)", () => {
  const gateCtx = {
    owner: "o", repo: "r", branch: "lastlight/1-x", issueDir: ".lastlight/issue-1",
    externalizeArtifacts: true, publicUrl: "https://dash",
    autonomyMerge: { configured: "gate", effective: "gate", auto: false, gate: true },
  } as any;
  const approvedDirty = { success: true, prNumber: 9, review: { approved: true, cycles: 0, headRefusal: "dirty-tree" } };
  const finalize = (db: any, github: any, over: Record<string, unknown> = {}) =>
    finalizeBuildReviewForRun(
      { workflowName: "build", result: approvedDirty, ctx: gateCtx, runId: "run-1", ...over } as any,
      { db, github: () => github, ...botDeps },
    );

  beforeEach(() => {
    evaluateMerge.mockReset();
  });

  it("posts one comment naming the refusal code, and a second finalize does not repeat it", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    expect(await finalize(db, github)).toBeNull();
    expect(await finalize(db, github)).toBeNull();
    expect(github.postComment).toHaveBeenCalledTimes(1);
    const [owner, repo, number, body] = github.postComment.mock.calls[0];
    expect([owner, repo, number]).toEqual(["o", "r", 9]);
    expect(body).toContain("`approval-unrecorded: dirty-tree`");
    expect(body).toMatch(/a human will need to merge/i);
    const ledger = db.scratch[MERGE_DECISIONS_SCRATCH_KEY] as any[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      trigger: "build-finished", decision: "hand-off", headSha: "head-after-push", commented: true,
    });
    expect(db.scratch[BUILD_REVIEW_SCRATCH_KEY]).toBeUndefined();
    expect(evaluateMerge).not.toHaveBeenCalled();
  });

  it("a new PR head gets its own comment", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    await finalize(db, github);
    github.getPullRequest.mockResolvedValue(pr({ head: { ref: "lastlight/1-x", sha: "newer", repo: { full_name: "o/r" } } }));
    await finalize(db, github);
    expect(github.postComment).toHaveBeenCalledTimes(2);
  });

  it("names the S2 mismatch when the PR head is not the reviewed commit", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    await finalize(db, github, {
      result: { success: true, prNumber: 9, review: { approved: true, headSha: "reviewed-earlier" } },
    });
    expect(github.postComment).toHaveBeenCalledTimes(1);
    expect(github.postComment.mock.calls[0][3]).toContain("`approval-unrecorded: head-not-reviewed`");
  });

  it("names an S1 mismatch on the bot's own PR", async () => {
    const db = fakeDb();
    const github = fakeGithub({ getPullRequest: vi.fn().mockResolvedValue(pr({ base: { ref: "release" } })) });
    await finalize(db, github);
    expect(github.postComment.mock.calls[0][3]).toContain("`approval-unrecorded: base-not-default`");
  });

  it("never comments on a PR another account opened", async () => {
    const db = fakeDb();
    const github = fakeGithub({ getPullRequest: vi.fn().mockResolvedValue(pr({ user: { login: "mallory" } })) });
    await finalize(db, github);
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("never comments on a bot PR whose head is not the run's branch (head-ref-mismatch)", async () => {
    // The agent-supplied PR number points at a different bot PR: commenting
    // there would hand the wrong PR to a human.
    const db = fakeDb();
    const github = fakeGithub({
      getPullRequest: vi.fn().mockResolvedValue(pr({ head: { ref: "lastlight/7-other", sha: "other", repo: { full_name: "o/r" } } })),
    });
    expect(await finalize(db, github)).toBeNull();
    expect(github.postComment).not.toHaveBeenCalled();
    expect(db.scratch[MERGE_DECISIONS_SCRATCH_KEY]).toBeUndefined();
  });

  it("an unknown capture refusal is reported as no-capture, never as agent text", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    await finalize(db, github, {
      result: { success: true, prNumber: 9, review: { approved: true, headRefusal: "@team please merge" } },
    });
    const body = github.postComment.mock.calls[0][3] as string;
    expect(body).toContain("`approval-unrecorded: no-capture`");
    expect(body).not.toContain("@team");
  });

  it("stays silent on a run the merge gate does not own", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    await finalize(db, github, { ctx: { ...gateCtx, autonomyMerge: { gate: false } } });
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("stays silent when REQUEST_CHANGES is refused", async () => {
    const db = fakeDb();
    const github = fakeGithub({ getPullRequest: vi.fn().mockResolvedValue(pr({ base: { ref: "release" } })) });
    await finalize(db, github, { result: { success: true, prNumber: 9, review: { approved: false } } });
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("never throws when the comment or the ledger write fails", async () => {
    const db = fakeDb();
    db.runs.getRun.mockRejectedValue(new Error("db gone"));
    const github = fakeGithub({ postComment: vi.fn().mockRejectedValue(new Error("502")) });
    await expect(finalize(db, github)).resolves.toBeNull();
  });

  it("a resumed gate run (stage marker, no autonomyMerge on the context) still comments", async () => {
    setRuntimeConfig({
      autonomy: {
        repos: ["o/r"],
        stages: { "ready-for-agent": { enter: "ready-for-agent", workflow: "build", gates: {}, on_merge: "gate" } },
        budget: {},
      },
    } as unknown as LastLightConfig);
    setAutonomyReposOverride(["o/r"]);
    setMergeReposOverride(["o/r"]);
    try {
      const db = fakeDb();
      const github = fakeGithub();
      const { autonomyMerge: _drop, ...resumed } = gateCtx;
      await finalize(db, github, { ctx: { ...resumed, _stage: "ready-for-agent" } });
      expect(github.postComment).toHaveBeenCalledTimes(1);
    } finally {
      resetRuntimeConfigForTests();
      setMergeReposOverride(null);
      setAutonomyReposOverride(null);
    }
  });
});
