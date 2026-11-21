import { describe, it, expect, vi } from "vitest";
import type { WorkflowRun } from "#src/state/workflow-run-store.js";
import {
  BUILD_REVIEW_SCRATCH_KEY,
  finalizeBuildReview,
  finalizeBuildReviewForRun,
  readBuildReview,
  recordBuildReview,
} from "#src/engine/build-review.js";
import { REVIEW_CHECK_NAME } from "#src/engine/review-check.js";

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
    },
  } as any;
}

function fakeGithub(over: Record<string, unknown> = {}) {
  return {
    getPullRequestHeadSha: vi.fn().mockResolvedValue("head-after-push"),
    createCheckRun: vi.fn().mockResolvedValue(7),
    ...over,
  } as any;
}

const base = {
  runId: "run-1",
  owner: "o",
  repo: "r",
  prNumber: 12,
  verdictUrl: "https://dash/verdict",
};

describe("finalizeBuildReview", () => {
  it("stores an APPROVED record pinned to the PR head and posts a success check there", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    const rec = await finalizeBuildReview({ ...base, approved: true }, { db, github });
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
    const rec = await finalizeBuildReview({ ...base, approved: false }, { db, github });
    expect(rec?.verdict).toBe("REQUEST_CHANGES");
    expect(github.createCheckRun).toHaveBeenCalledWith(
      "o", "r", "head-after-push", REVIEW_CHECK_NAME,
      expect.objectContaining({ conclusion: "failure" }),
    );
  });

  it("records nothing and never throws when the PR head cannot be read", async () => {
    const db = fakeDb();
    const github = fakeGithub({ getPullRequestHeadSha: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(finalizeBuildReview({ ...base, approved: true }, { db, github })).resolves.toBeNull();
    expect(db.runs.mergeScratch).not.toHaveBeenCalled();
    expect(github.createCheckRun).not.toHaveBeenCalled();
  });

  it("keeps the record when posting the check fails", async () => {
    const db = fakeDb();
    const github = fakeGithub({ createCheckRun: vi.fn().mockRejectedValue(new Error("403")) });
    const rec = await finalizeBuildReview({ ...base, approved: true }, { db, github });
    expect(rec?.verdict).toBe("APPROVED");
    expect(db.scratch[BUILD_REVIEW_SCRATCH_KEY]).toEqual(rec);
  });

  it("does nothing without a PR or a GitHub client", async () => {
    const db = fakeDb();
    expect(await finalizeBuildReview({ ...base, prNumber: 0, approved: true }, { db, github: fakeGithub() })).toBeNull();
    expect(await finalizeBuildReview({ ...base, approved: true }, { db, github: null })).toBeNull();
    expect(db.runs.mergeScratch).not.toHaveBeenCalled();
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
  const ok = { success: true, prNumber: 9, review: { approved: true, cycles: 0 } };

  it("links the verdict artifact and records for a build that opened a PR", async () => {
    const db = fakeDb();
    const github = fakeGithub();
    const rec = await finalizeBuildReviewForRun(
      { workflowName: "build", result: ok, ctx, runId: "run-1" },
      { db, github: () => github },
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
      await finalizeBuildReviewForRun({ ...(a as any), ctx, runId: "run-1" }, { db, github: () => github }),
    ).toBeNull();
    expect(github.getPullRequestHeadSha).not.toHaveBeenCalled();
  });

  it("never throws when the client cannot be resolved", async () => {
    const db = fakeDb();
    const rec = await finalizeBuildReviewForRun(
      { workflowName: "build", result: ok, ctx, runId: "run-1" },
      { db, github: () => { throw new Error("no auth"); } },
    );
    expect(rec).toBeNull();
  });
});
