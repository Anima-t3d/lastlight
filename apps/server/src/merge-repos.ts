import { getMergeRepos, setMergeReposOverride } from "./config/config.js";

/**
 * The merge opt-in list: the repos where the autonomous merge gate may merge a
 * pull request, editable from Config → Managed repos (the Merges toggle beside
 * Builds). Stored as one `harness_settings` row (key
 * {@link MERGE_REPOS_SETTING_KEY}); there is no YAML counterpart, so the list is
 * empty until an operator turns a repo on. The in-memory copy feeds the
 * synchronous `isMergeRepo()`, the same pattern as `autonomy-repos.ts`.
 *
 * A repo can be on this list only while it is on the autonomy list: Merges is a
 * further step on top of Builds (see `managed-repo-approvals.ts`).
 */
export interface MergeReposState {
  repos: string[];
}

export const MERGE_REPOS_SETTING_KEY = "merge-repos";

let stored = false;
/**
 * Bumped by every write, so a timer refresh that read the row BEFORE a write
 * landed drops its (older) result instead of reverting the write in memory.
 */
let generation = 0;

function cache(state: MergeReposState | null): void {
  stored = state !== null;
  setMergeReposOverride(state ? state.repos : null);
}

/** Cache setter for a just-written row (or null = no row). */
export function setStoredMergeRepos(state: MergeReposState | null): void {
  generation++;
  cache(state);
}

/** The merge list in effect, and whether it came from a stored row. */
export function getMergeReposState(): { state: MergeReposState; stored: boolean } {
  return { state: { repos: getMergeRepos() }, stored };
}

/**
 * Re-read the stored row into the in-memory copy. Called at boot and on a
 * timer; the process that made a change updates its copy directly.
 */
export async function refreshMergeRepos(
  db: { getSetting<T>(key: string): Promise<{ value: T } | null> },
): Promise<void> {
  const started = generation;
  const row = await db.getSetting<unknown>(MERGE_REPOS_SETTING_KEY);
  if (started !== generation) return; // a write landed meanwhile; it is newer
  cache(row ? normalizeMergeRepos(row.value) : null);
}

/**
 * Parse a stored row. A malformed one FAILS CLOSED: only its valid entries may
 * merge, never more.
 */
export function normalizeMergeRepos(raw: unknown): MergeReposState {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const list = Array.isArray(v?.repos) ? (v!.repos as unknown[]) : [];
  return { repos: list.filter((r): r is string => typeof r === "string" && !!r.trim()).map((r) => r.trim()) };
}

/** Test-only: forget the stored row. */
export function resetMergeReposForTests(): void {
  generation = 0;
  cache(null);
}
