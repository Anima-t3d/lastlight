/**
 * Host-side file access inside a sandbox workspace that never follows a symlink.
 *
 * Between phases the harness reads and writes files in a workspace the agent
 * controlled a moment earlier: it writes AGENTS.md and script files, reads the
 * verify script and the PR-notes journal, reads fanout branch files. Those
 * paths are fixed and predictable, so an agent can replace one with a symlink
 * to a host file (the database, the App key), and a plain `readFileSync` /
 * `writeFileSync` running as the harness user would follow it. Every helper
 * here checks each path component with `lstat` and opens with `O_NOFOLLOW`.
 * Only regular files are opened (and with `O_NONBLOCK`): a planted FIFO would
 * otherwise block the open — and with it the harness's event loop — forever.
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

/**
 * True when `absPath` lies under `root` and no component from `root` down to
 * it is a symlink. Every directory on the way must exist; the leaf itself may
 * be absent (a file about to be created), but if present it must not be a
 * symlink.
 */
export function isContainedRealPath(root: string, absPath: string): boolean {
  const base = resolve(root);
  const target = resolve(absPath);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  try {
    if (lstatSync(base).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const parts = rel.split(sep);
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    const leaf = i === parts.length - 1;
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return leaf;
    }
    if (st.isSymbolicLink()) return false;
    if (!leaf && !st.isDirectory()) return false;
  }
  return true;
}

/** Flags for opening a workspace file the agent may have tampered with. */
export const NOFOLLOW_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The file's text, or null when it is absent, not a regular file, symlinked anywhere, or outside `root`. */
export function readWorkspaceFile(root: string, relPath: string): string | null {
  const abs = resolve(root, relPath);
  if (!isContainedRealPath(root, abs)) return null;
  let fd: number;
  try {
    if (!lstatSync(abs).isFile()) return null;
    fd = openSync(abs, NOFOLLOW_READ);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Write `data` to `root/relPath`. A symlink at the target is removed first (the
 * agent planted it; the harness owns this file), a symlinked or missing parent
 * or an escaping path throws.
 */
export function writeWorkspaceFile(root: string, relPath: string, data: string): void {
  const abs = resolve(root, relPath);
  const planted = plantedLeaf(root, abs);
  if (!planted && !isContainedRealPath(root, abs)) {
    throw new Error(`Refusing to write ${relPath}: not a plain path inside the workspace`);
  }
  // A hardlink shares its inode with a file elsewhere: O_TRUNC would rewrite that one too.
  if (planted || hardlinked(abs)) unlinkSync(abs);
  const fd = openSync(
    abs,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o644,
  );
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/**
 * `mkdir -p root/relPath`, one level at a time, refusing a symlinked or
 * non-directory component (a recursive `mkdirSync` would create through it).
 */
export function mkdirWorkspaceDir(root: string, relPath: string): void {
  const base = resolve(root);
  const target = resolve(base, relPath);
  const rel = relative(base, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing to create ${relPath}: outside the workspace`);
  }
  if (lstatSync(base).isSymbolicLink()) throw new Error(`Refusing to create ${relPath}: the workspace root is a symlink`);
  let cur = base;
  for (const part of rel ? rel.split(sep) : []) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Refusing to create ${relPath}: ${relative(base, cur)} is not a plain directory`);
    }
  }
}

/**
 * Unlink every symlink under `dir` without following any; returns how many.
 * For trees the harness copies in or out wholesale (`cpSync` writes through a
 * symlink at the destination, and stores one found at the source).
 */
export function removeSymlinksUnder(dir: string): number {
  try {
    // A symlinked `dir` is the caller's to refuse (isContainedRealPath); never walk its target.
    if (lstatSync(dir).isSymbolicLink()) return 0;
  } catch {
    return 0;
  }
  let removed = 0;
  // Iterative: the agent decides how deep the tree is. A subdirectory that
  // cannot be read throws — skipping it would leave its symlinks in place.
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, e.name);
      if (e.isSymbolicLink()) {
        unlinkSync(abs);
        removed++;
      } else if (e.isDirectory()) {
        stack.push(abs);
      }
    }
  }
  return removed;
}

/** A regular file whose inode has other names. */
function hardlinked(abs: string): boolean {
  try {
    const st = lstatSync(abs);
    return st.isFile() && st.nlink > 1;
  } catch {
    return false;
  }
}

/**
 * The leaf is something the harness never puts there — a symlink, FIFO, socket
 * or device — while everything above it is a plain in-root directory.
 */
function plantedLeaf(root: string, abs: string): boolean {
  const parent = dirname(abs);
  try {
    const parentOk = resolve(parent) === resolve(root)
      ? !lstatSync(parent).isSymbolicLink()
      : isContainedRealPath(root, parent) && lstatSync(parent).isDirectory();
    if (!parentOk) return false;
    const st = lstatSync(abs);
    return !st.isFile() && !st.isDirectory();
  } catch {
    return false;
  }
}
