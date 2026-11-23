/** Table tests for the build's own notes dir and the notes-only advance check. */
import { describe, it, expect } from "vitest";
import {
  COMPARE_FILES_CAP,
  isInOwnNotesDir,
  notesOnlyAdvance,
  type CommitComparison,
} from "#src/engine/own-notes.js";

describe("isInOwnNotesDir", () => {
  it.each([
    [".lastlight/issue-12/status.md", 12, true],
    [".lastlight/issue-12/nested/x.md", 12, true],
    [".lastlight/issue-12/", 12, false],
    [".lastlight/issue-12", 12, false],
    [".lastlight/issue-120/x", 12, false],
    [".lastlight/issue-12x/x", 12, false],
    [".lastlight/issue-13/x", 12, false],
    [".lastlight/lastlight.yml", 12, false],
    ["src/x.js", 12, false],
    ["a/.lastlight/issue-12/x", 12, false],
    [".lastlight/issue-0/x", 0, false],
    [".lastlight/issue-NaN/x", Number.NaN, false],
    [".lastlight/issue-1.5/x", 1.5, false],
  ])("%s for issue %s -> %s", (p, n, ok) => {
    expect(isInOwnNotesDir(p, n)).toBe(ok);
  });
});

const cmp = (over: Partial<CommitComparison> = {}): CommitComparison => ({
  status: "ahead",
  behindBy: 0,
  files: [
    { filename: ".lastlight/issue-12/reviewer-verdict.md" },
    { filename: ".lastlight/issue-12/status.md" },
  ],
  ...over,
});
const many = (n: number) => Array.from({ length: n }, (_, k) => ({ filename: `.lastlight/issue-12/n${k}.md` }));

describe("notesOnlyAdvance", () => {
  const rows: Array<[string, CommitComparison, number, boolean, string?]> = [
    ["notes-only, ahead", cmp(), 12, true],
    ["no files changed, ahead", cmp({ files: [] }), 12, true],
    ["rename inside the own dir", cmp({ files: [{ filename: ".lastlight/issue-12/b", previousFilename: ".lastlight/issue-12/a" }] }), 12, true],
    ["ahead with a src/ change", cmp({ files: [{ filename: ".lastlight/issue-12/status.md" }, { filename: "src/x.js" }] }), 12, false, "outside-notes"],
    ["behind_by > 0", cmp({ behindBy: 1 }), 12, false, "not-ancestor"],
    ["diverged", cmp({ status: "diverged", behindBy: 2 }), 12, false, "not-ancestor"],
    ["behind", cmp({ status: "behind", behindBy: 1 }), 12, false, "not-ancestor"],
    ["identical", cmp({ status: "identical" }), 12, false, "not-ancestor"],
    ["rename out of the notes dir", cmp({ files: [{ filename: "src/x.js", previousFilename: ".lastlight/issue-12/x" }] }), 12, false, "outside-notes"],
    ["rename into the notes dir from src/", cmp({ files: [{ filename: ".lastlight/issue-12/x", previousFilename: "src/x.js" }] }), 12, false, "outside-notes"],
    ["another issue's notes", cmp({ files: [{ filename: ".lastlight/issue-13/status.md" }] }), 12, false, "outside-notes"],
    ["file list missing", cmp({ files: null }), 12, false, "files-incomplete"],
    ["300 files (the API cap)", cmp({ files: many(COMPARE_FILES_CAP) }), 12, false, "files-incomplete"],
    ["299 notes files", cmp({ files: many(COMPARE_FILES_CAP - 1) }), 12, true],
    ["bad issue number", cmp(), 0, false, "outside-notes"],
  ];
  it.each(rows)("%s", (_n, c, issue, ok, kase) => {
    const r = notesOnlyAdvance(c, issue);
    expect(r.ok).toBe(ok);
    if (!r.ok) expect(r.reason.startsWith(`${kase}: `)).toBe(true);
  });
});
