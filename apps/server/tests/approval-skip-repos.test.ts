import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  APPROVAL_SKIP_REPOS_SETTING_KEY,
  getApprovalSkipReposState,
  refreshApprovalSkipRepos,
  setStoredApprovalSkipRepos,
  resetApprovalSkipReposForTests,
} from "#src/approval-skip-repos.js";
import { getApprovalSkipRepos, isApprovalSkipRepo } from "#src/config/config.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "./helpers/state-db.js";

describe("approval skip repos — live setting", () => {
  let db: StateDb;

  beforeEach(async () => {
    db = await makeTestDb();
  });

  afterEach(() => {
    resetApprovalSkipReposForTests();
  });

  it("empty by default: every repo keeps the build-stage gates", async () => {
    await refreshApprovalSkipRepos(db);
    expect(getApprovalSkipRepos()).toEqual([]);
    expect(isApprovalSkipRepo("a/one")).toBe(false);
    expect(getApprovalSkipReposState()).toEqual({ state: { repos: [] }, stored: false });
  });

  it("the key is approval-skip-repos", () => {
    expect(APPROVAL_SKIP_REPOS_SETTING_KEY).toBe("approval-skip-repos");
  });

  it("stored row is read on refresh", async () => {
    await db.setSetting(APPROVAL_SKIP_REPOS_SETTING_KEY, { repos: ["a/two"] });
    await refreshApprovalSkipRepos(db);
    expect(isApprovalSkipRepo("a/two")).toBe(true);
    expect(getApprovalSkipReposState()).toEqual({ state: { repos: ["a/two"] }, stored: true });
  });

  it("set updates the in-memory copy", () => {
    setStoredApprovalSkipRepos({ repos: ["a/three"] });
    expect(getApprovalSkipRepos()).toEqual(["a/three"]);
    expect(getApprovalSkipReposState().stored).toBe(true);
    setStoredApprovalSkipRepos(null);
    expect(getApprovalSkipRepos()).toEqual([]);
  });

  it("malformed row keeps only valid entries", async () => {
    await db.setSetting(APPROVAL_SKIP_REPOS_SETTING_KEY, { repos: ["a/two", 7, ""] });
    await refreshApprovalSkipRepos(db);
    expect(getApprovalSkipRepos()).toEqual(["a/two"]);
    await db.setSetting(APPROVAL_SKIP_REPOS_SETTING_KEY, "junk");
    await refreshApprovalSkipRepos(db);
    expect(getApprovalSkipRepos()).toEqual([]);
  });

  it("refresh that started before a write is dropped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowDb = {
      async getSetting<T>(): Promise<{ value: T } | null> {
        await gate;
        return { value: { repos: ["a/old"] } as T };
      },
    };
    const pending = refreshApprovalSkipRepos(slowDb);
    setStoredApprovalSkipRepos({ repos: ["a/three"] });
    release();
    await pending;
    expect(getApprovalSkipRepos()).toEqual(["a/three"]);
  });

  it("isApprovalSkipRepo is exact match", () => {
    setStoredApprovalSkipRepos({ repos: ["a/one"] });
    expect(isApprovalSkipRepo("a/one")).toBe(true);
    expect(isApprovalSkipRepo("A/One")).toBe(false);
  });
});
