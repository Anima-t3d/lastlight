import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MERGE_REPOS_SETTING_KEY,
  getMergeReposState,
  refreshMergeRepos,
  setStoredMergeRepos,
  resetMergeReposForTests,
} from "#src/merge-repos.js";
import { getMergeRepos, isMergeRepo } from "#src/config/config.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "./helpers/state-db.js";

describe("merge repos — live setting", () => {
  let db: StateDb;

  beforeEach(async () => {
    db = await makeTestDb();
  });

  afterEach(() => {
    resetMergeReposForTests();
  });

  it("empty by default: no repo merges", async () => {
    await refreshMergeRepos(db);
    expect(getMergeRepos()).toEqual([]);
    expect(isMergeRepo("a/one")).toBe(false);
    expect(getMergeReposState()).toEqual({ state: { repos: [] }, stored: false });
  });

  it("stored row is read on refresh", async () => {
    await db.setSetting(MERGE_REPOS_SETTING_KEY, { repos: ["a/two"] });
    await refreshMergeRepos(db);
    expect(isMergeRepo("a/two")).toBe(true);
    expect(getMergeReposState()).toEqual({ state: { repos: ["a/two"] }, stored: true });
  });

  it("malformed row keeps only valid entries", async () => {
    await db.setSetting(MERGE_REPOS_SETTING_KEY, { repos: ["a/two", 7, ""] });
    await refreshMergeRepos(db);
    expect(getMergeRepos()).toEqual(["a/two"]);
    await db.setSetting(MERGE_REPOS_SETTING_KEY, "junk");
    await refreshMergeRepos(db);
    expect(getMergeRepos()).toEqual([]);
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
    const pending = refreshMergeRepos(slowDb);
    setStoredMergeRepos({ repos: ["a/three"] });
    release();
    await pending;
    expect(getMergeRepos()).toEqual(["a/three"]);
  });

  it("isMergeRepo is exact match", () => {
    setStoredMergeRepos({ repos: ["a/one"] });
    expect(isMergeRepo("a/one")).toBe(true);
    expect(isMergeRepo("A/One")).toBe(false);
  });
});
