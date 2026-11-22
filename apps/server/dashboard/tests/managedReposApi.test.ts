/**
 * Config → Managed repos writes: the Approvals toggle posts to the server's
 * `/managed-repos/approvals` with the same body shape as Builds and Merges.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ approvalSkip: ["a/one"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

const { api, ApiError } = await import("../src/api");

describe("api.setRepoApprovals", () => {
  it("posts { repo, enabled } to /managed-repos/approvals and returns the view", async () => {
    const view = await api.setRepoApprovals("a/one", false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/admin/api/managed-repos/approvals");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ repo: "a/one", enabled: false });
    expect(view).toEqual({ approvalSkip: ["a/one"] });
  });

  it("surfaces 400 approvals-requires-builds as an ApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "approvals-requires-builds" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const err = await api.setRepoApprovals("a/two", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).message).toBe("approvals-requires-builds");
  });
});
