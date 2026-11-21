import { describe, it, expect, vi } from "vitest";
import { GitHubClient } from "#src/engine/github/github.js";

function clientWith(octokit: unknown): GitHubClient {
  const c = GitHubClient.withToken("t", "http://mock");
  (c as unknown as { staticOctokit: unknown }).staticOctokit = octokit;
  return c;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("mergePullRequest", () => {
  const merge = (fn: () => unknown) => {
    const c = clientWith({ rest: { pulls: { merge: vi.fn(fn) } } });
    return c.mergePullRequest("o", "r", 7, { sha: "abc", method: "squash" });
  };

  it("sends sha + squash and returns merged with the merge sha", async () => {
    const mergeFn = vi.fn(async () => ({ data: { merged: true, sha: "m1", message: "ok" } }));
    const c = clientWith({ rest: { pulls: { merge: mergeFn } } });
    const out = await c.mergePullRequest("o", "r", 7, { sha: "abc", method: "squash" });
    expect(out).toEqual({ outcome: "merged", sha: "m1", message: "ok" });
    expect(mergeFn).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 7,
      sha: "abc",
      merge_method: "squash",
    });
  });

  it("maps 409 to head-moved", async () => {
    const out = await merge(async () => {
      throw httpError(409, "Head branch was modified. Review and try the merge again.");
    });
    expect(out.outcome).toBe("head-moved");
  });

  it("maps 405 'already merged' to already-merged", async () => {
    const out = await merge(async () => {
      throw httpError(405, "Pull Request is already merged");
    });
    expect(out.outcome).toBe("already-merged");
  });

  it("maps other 405 to not-mergeable with the message", async () => {
    const out = await merge(async () => {
      throw httpError(405, "Required status check is expected");
    });
    expect(out).toEqual({ outcome: "not-mergeable", message: "Required status check is expected" });
  });

  it("maps 422 to not-mergeable", async () => {
    const out = await merge(async () => {
      throw httpError(422, "Merge method not allowed");
    });
    expect(out).toEqual({ outcome: "not-mergeable", message: "Merge method not allowed" });
  });

  it.each([401, 403, 500])("propagates %i", async (status) => {
    await expect(
      merge(async () => {
        throw httpError(status, "boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("propagates network errors", async () => {
    await expect(
      merge(async () => {
        throw new Error("ECONNRESET");
      }),
    ).rejects.toThrow("ECONNRESET");
  });
});

describe("listIssueDependencies", () => {
  const issue = (n: number, state = "open", state_reason: string | null = null) => ({
    number: n,
    state,
    state_reason,
    title: "x",
  });

  it("paginates blocked_by across two pages and maps fields", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => issue(i + 1));
    const page2 = [issue(101, "closed", "completed"), issue(102, "closed", "not_planned")];
    const request = vi.fn(async (_route: string, p: { page: number }) => ({
      data: p.page === 1 ? page1 : p.page === 2 ? page2 : [],
    }));
    const c = clientWith({ request });
    const out = await c.listIssueDependencies("o", "r", 5, "blocked_by");
    expect(out).toHaveLength(102);
    expect(out[0]).toEqual({ number: 1, state: "open", stateReason: null });
    expect(out[100]).toEqual({ number: 101, state: "closed", stateReason: "completed" });
    expect(out[101].stateReason).toBe("not_planned");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
    );
    expect(request.mock.calls[0][1]).toMatchObject({ owner: "o", repo: "r", issue_number: 5, per_page: 100 });
  });

  it("uses the blocking route", async () => {
    const request = vi.fn(async () => ({ data: [issue(9, "open", "reopened")] }));
    const out = await clientWith({ request }).listIssueDependencies("o", "r", 5, "blocking");
    expect(out).toEqual([{ number: 9, state: "open", stateReason: "reopened" }]);
    expect((request.mock.calls[0] as unknown[])[0]).toContain("/dependencies/blocking");
  });
});

describe("listPullRequestFilePaths renames", () => {
  it("returns both the new and previous path for a rename, deduped", async () => {
    const listFiles = vi.fn(async () => ({
      data: [
        { filename: "new/a.ts", previous_filename: "old/a.ts", status: "renamed" },
        { filename: "b.ts", status: "modified" },
        { filename: "old/a.ts", status: "added" },
      ],
    }));
    const c = clientWith({ rest: { pulls: { listFiles } } });
    expect(await c.listPullRequestFilePaths("o", "r", 1)).toEqual(["new/a.ts", "old/a.ts", "b.ts"]);
  });
});
