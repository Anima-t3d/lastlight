import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isContainedRealPath, mkdirWorkspaceDir, readWorkspaceFile, removeSymlinksUnder, writeWorkspaceFile } from "#src/engine/workspace-fs.js";

// Between phases the harness reads and writes files inside a workspace the
// agent controlled a moment ago. A planted symlink must never turn those into
// reads or writes of host files outside the workspace.

let base: string;
let root: string;
let secret: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "wsfs-"));
  root = join(base, "ws");
  mkdirSync(join(root, "sub"), { recursive: true });
  secret = join(base, "secret.txt");
  writeFileSync(secret, "TOP-SECRET");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("isContainedRealPath", () => {
  it("accepts a plain file and a not-yet-existing leaf under the root", () => {
    writeFileSync(join(root, "sub", "a.txt"), "a");
    expect(isContainedRealPath(root, join(root, "sub", "a.txt"))).toBe(true);
    expect(isContainedRealPath(root, join(root, "sub", "new.txt"))).toBe(true);
  });

  it("rejects a symlinked leaf, a symlinked parent and a path outside the root", () => {
    symlinkSync(secret, join(root, "link.txt"));
    symlinkSync(base, join(root, "up"));
    expect(isContainedRealPath(root, join(root, "link.txt"))).toBe(false);
    expect(isContainedRealPath(root, join(root, "up", "secret.txt"))).toBe(false);
    expect(isContainedRealPath(root, join(root, "..", "secret.txt"))).toBe(false);
  });

  it("rejects a missing middle component", () => {
    expect(isContainedRealPath(root, join(root, "nope", "x.txt"))).toBe(false);
  });
});

describe("readWorkspaceFile", () => {
  it("reads a plain file", () => {
    writeFileSync(join(root, "sub", "a.txt"), "hello");
    expect(readWorkspaceFile(root, "sub/a.txt")).toBe("hello");
  });

  it("returns null for absent, symlinked, parent-symlinked and escaping paths", () => {
    symlinkSync(secret, join(root, "link.txt"));
    symlinkSync(base, join(root, "up"));
    expect(readWorkspaceFile(root, "absent.txt")).toBeNull();
    expect(readWorkspaceFile(root, "link.txt")).toBeNull();
    expect(readWorkspaceFile(root, "up/secret.txt")).toBeNull();
    expect(readWorkspaceFile(root, "../secret.txt")).toBeNull();
  });
});

describe("writeWorkspaceFile", () => {
  it("writes a plain file, creating it", () => {
    writeWorkspaceFile(root, "sub/b.txt", "data");
    expect(readFileSync(join(root, "sub", "b.txt"), "utf8")).toBe("data");
  });

  it("replaces a planted symlink with a regular file and leaves its target alone", () => {
    symlinkSync(secret, join(root, "AGENTS.md"));
    writeWorkspaceFile(root, "AGENTS.md", "context");
    expect(lstatSync(join(root, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("context");
    expect(readFileSync(secret, "utf8")).toBe("TOP-SECRET");
  });

  it("throws on a symlinked parent and on an escaping path, writing nothing outside", () => {
    symlinkSync(base, join(root, "up"));
    expect(() => writeWorkspaceFile(root, "up/secret.txt", "x")).toThrow();
    expect(() => writeWorkspaceFile(root, "../evil.txt", "x")).toThrow();
    expect(readFileSync(secret, "utf8")).toBe("TOP-SECRET");
    expect(existsSync(join(base, "evil.txt"))).toBe(false);
  });
});

describe("mkdirWorkspaceDir", () => {
  it("creates missing directories one level at a time", () => {
    mkdirWorkspaceDir(root, "a/b/c");
    expect(lstatSync(join(root, "a", "b", "c")).isDirectory()).toBe(true);
  });

  it("throws on a symlinked component instead of creating through it", () => {
    symlinkSync(base, join(root, "up"));
    expect(() => mkdirWorkspaceDir(root, "up/made")).toThrow();
    expect(existsSync(join(base, "made"))).toBe(false);
  });

  it("throws on an escaping path", () => {
    expect(() => mkdirWorkspaceDir(root, "../outside")).toThrow();
    expect(existsSync(join(base, "outside"))).toBe(false);
  });
});

describe("removeSymlinksUnder", () => {
  it("unlinks every symlink in the tree without following any", () => {
    mkdirSync(join(root, "d", "e"), { recursive: true });
    writeFileSync(join(root, "d", "keep.md"), "k");
    symlinkSync(secret, join(root, "d", "leak.md"));
    symlinkSync(base, join(root, "d", "e", "updir"));
    expect(removeSymlinksUnder(join(root, "d"))).toBe(2);
    expect(existsSync(join(root, "d", "leak.md"))).toBe(false);
    expect(existsSync(join(root, "d", "e", "updir"))).toBe(false);
    expect(readFileSync(join(root, "d", "keep.md"), "utf8")).toBe("k");
    expect(readFileSync(secret, "utf8")).toBe("TOP-SECRET");
  });

  it("is a no-op for an absent directory", () => {
    expect(removeSymlinksUnder(join(root, "absent"))).toBe(0);
  });
});
