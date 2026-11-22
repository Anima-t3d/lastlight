import { getApprovalSkipRepos, setApprovalSkipReposOverride } from "./config/config.js";

/**
 * The approval opt-OUT list: the repos whose autonomous builds run without the
 * build stage's approval gates (`autonomy.stages.<stage>.gates`, e.g.
 * `post_architect` / `post_reviewer`). Editable from Config → Managed repos
 * (the Approvals toggle beside Builds and Merges; unchecked = on this list).
 * Stored as one `harness_settings` row (key
 * {@link APPROVAL_SKIP_REPOS_SETTING_KEY}); there is no YAML counterpart, so the
 * list is empty until an operator turns a repo's approvals off, and every repo
 * keeps the stage gates. The in-memory copy feeds the synchronous
 * `isApprovalSkipRepo()`, the same pattern as `merge-repos.ts`.
 *
 * Only the stage-added gates are skipped: the operator's own `approval:` map
 * still applies, and a human `@bot build` (no stage) is unaffected. A repo can
 * be on this list only while it is on the autonomy list (see
 * `managed-repo-approvals.ts`).
 */
export interface ApprovalSkipReposState {
  repos: string[];
}

export const APPROVAL_SKIP_REPOS_SETTING_KEY = "approval-skip-repos";

let stored = false;
/**
 * Bumped by every write, so a timer refresh that read the row BEFORE a write
 * landed drops its (older) result instead of reverting the write in memory.
 */
let generation = 0;

function cache(state: ApprovalSkipReposState | null): void {
  stored = state !== null;
  setApprovalSkipReposOverride(state ? state.repos : null);
}

/** Cache setter for a just-written row (or null = no row). */
export function setStoredApprovalSkipRepos(state: ApprovalSkipReposState | null): void {
  generation++;
  cache(state);
}

/** The skip list in effect, and whether it came from a stored row. */
export function getApprovalSkipReposState(): { state: ApprovalSkipReposState; stored: boolean } {
  return { state: { repos: getApprovalSkipRepos() }, stored };
}

/**
 * Re-read the stored row into the in-memory copy. Called at boot and on a
 * timer; the process that made a change updates its copy directly.
 */
export async function refreshApprovalSkipRepos(
  db: { getSetting<T>(key: string): Promise<{ value: T } | null> },
): Promise<void> {
  const started = generation;
  const row = await db.getSetting<unknown>(APPROVAL_SKIP_REPOS_SETTING_KEY);
  if (started !== generation) return; // a write landed meanwhile; it is newer
  cache(row ? normalizeApprovalSkipRepos(row.value) : null);
}

/**
 * Parse a stored row. A malformed one keeps only its valid entries, and an
 * unreadable one is empty: approvals stay on for every repo it cannot name.
 */
export function normalizeApprovalSkipRepos(raw: unknown): ApprovalSkipReposState {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const list = Array.isArray(v?.repos) ? (v!.repos as unknown[]) : [];
  return { repos: list.filter((r): r is string => typeof r === "string" && !!r.trim()).map((r) => r.trim()) };
}

/** Test-only: forget the stored row. */
export function resetApprovalSkipReposForTests(): void {
  generation = 0;
  cache(null);
}
