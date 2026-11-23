/**
 * A build run's own notes dir, `.lastlight/issue-<N>/`, and the one question
 * the merge gate asks about it: did the PR move past the reviewed commit ONLY
 * by notes in that dir? PURE, and dependency-free so the runner-loaded
 * `build-review.ts` and the merge gate can both use it.
 *
 * Why it matters: the reviewer writes `reviewer-verdict.md` and `status.md`
 * into the dir after reviewing, and the `pr` phase updates `status.md` again,
 * so the PR head is always a notes commit or two past the reviewed code. Those
 * notes describe the review; they are not code the review should have read.
 *
 * `<N>` is always the run's issue number from our own run record, never agent
 * text. A path counts only when it is STRICTLY inside the dir: the dir itself,
 * `issue-<N>` as a file, `issue-<N>0/…` and a nested `a/.lastlight/…` do not.
 */

/** `.lastlight/issue-<N>/`, or null when `issueNumber` is not a positive integer. */
export function ownNotesDir(issueNumber: number): string | null {
  return Number.isInteger(issueNumber) && issueNumber > 0 ? `.lastlight/issue-${issueNumber}/` : null;
}

/** `path` is strictly inside the build's own notes dir (the matcher from dde10abd). */
export function isInOwnNotesDir(path: string, issueNumber: number): boolean {
  const dir = ownNotesDir(issueNumber);
  return dir !== null && path.startsWith(dir) && path.length > dir.length;
}

/** GitHub's compare endpoint lists at most this many files; a list this long may be cut. */
export const COMPARE_FILES_CAP = 300;

/** What `compareCommits(reviewedSha...head)` reported, in the shape this check reads. */
export interface CommitComparison {
  /** `ahead` | `behind` | `diverged` | `identical`. */
  status: string;
  behindBy: number;
  /** Every changed file with its rename source, or null when GitHub sent none. */
  files: ReadonlyArray<{ filename: string; previousFilename?: string | null }> | null;
}

export type NotesOnlyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The head is the reviewed commit plus notes only: `reviewedSha` is an ancestor
 * of the head (`ahead`, `behind_by` 0: no force-push or rebase), the file list
 * is complete (present and under the cap), and every `filename` AND
 * `previous_filename` is strictly inside the own notes dir. Fails closed.
 */
export function notesOnlyAdvance(cmp: CommitComparison, issueNumber: number): NotesOnlyVerdict {
  if (cmp.status !== "ahead" || cmp.behindBy !== 0) {
    return { ok: false, reason: `not-ancestor: compare status is "${cmp.status}", behind by ${cmp.behindBy}` };
  }
  if (!cmp.files || cmp.files.length >= COMPARE_FILES_CAP) {
    return { ok: false, reason: "files-incomplete: the compare file list is missing or may be truncated" };
  }
  for (const f of cmp.files) {
    for (const p of [f.filename, f.previousFilename]) {
      if (p === undefined || p === null) continue;
      if (!isInOwnNotesDir(p, issueNumber)) {
        return { ok: false, reason: `outside-notes: ${p} is not in the build's own notes dir` };
      }
    }
  }
  return { ok: true };
}
