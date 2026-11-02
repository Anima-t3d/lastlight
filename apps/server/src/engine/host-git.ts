import {
  execFileSync,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
} from "child_process";
import { lstatSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import {
  isContainedRealPath,
  readWorkspaceFile,
  removeSymlinksUnder,
  writeWorkspaceFile,
} from "./workspace-fs.js";

/**
 * Host-side git (provisioning, refresh, post-review's diff) runs as the server's
 * user against a checkout the agent has written to. Git reads programs to run
 * from that checkout — `.git/hooks/*`, and `.git/config` keys such as
 * `core.fsmonitor`, `diff.external` or `filter.*` — and paths to act on, such as
 * `core.worktree` or `url.*.insteadOf`. Two layers keep all of it inert:
 *
 *  - every host git call carries {@link HOST_GIT_GUARD}, which wins over any
 *    config file and switches hooks and fsmonitor off;
 *  - {@link sanitizeCheckout} runs before host git touches a checkout the agent
 *    has had, and rewrites `.git/config` down to the keys the harness itself
 *    writes, so no other config key survives to be read.
 */
export const HOST_GIT_GUARD = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * `git -C <repoDir>` with {@link HOST_GIT_GUARD}, pinned to `<repoDir>/.git`:
 * with no `.git` there git fails rather than search the directories above,
 * where the workspace root is the agent's to plant a repository in.
 */
export function hostGit(repoDir: string, args: string[], opts: ExecFileSyncOptionsWithStringEncoding): string;
export function hostGit(repoDir: string, args: string[], opts?: ExecFileSyncOptions): string | Buffer;
export function hostGit(repoDir: string, args: string[], opts: ExecFileSyncOptions = { stdio: "pipe" }): string | Buffer {
  const env = { ...(opts.env ?? process.env), GIT_DIR: resolve(repoDir, ".git"), GIT_WORK_TREE: resolve(repoDir) };
  return execFileSync("git", ["-C", repoDir, ...HOST_GIT_GUARD, ...args], { ...opts, env });
}

/** The checkout is shaped so that host git would act on something outside it. */
export class UnsafeCheckoutError extends Error {
  constructor(repoDir: string, reason: string) {
    super(`Refusing to run git in ${repoDir}: ${reason}`);
    this.name = "UnsafeCheckoutError";
  }
}

// Branch and ref names the harness creates; anything else in a value is dropped.
const SAFE_REF = /^[\w./@+-]+$/;
const DEFAULT_FETCH = "+refs/heads/*:refs/remotes/origin/*";

/**
 * Make an agent-touched checkout safe for host git, or throw
 * {@link UnsafeCheckoutError}. A no-op when `repoDir` or its `.git` is absent.
 *
 * Refuses a `repoDir` that leaves `workDir`, and a `.git` that is not a plain
 * directory (a symlink, or a gitfile naming another repository) or that borrows
 * another one through `commondir`. Then removes every symlink under `.git` and
 * any object alternates, and rewrites `.git/config` keeping only the origin URL
 * (reset to `originUrl`), its `refs/heads → refs/remotes/origin` fetch refspecs,
 * and branch tracking.
 */
export function sanitizeCheckout(workDir: string, repoDir: string, originUrl: string): void {
  const kind = lstatKind(repoDir);
  if (kind === "absent") return;
  if (kind !== "dir" || !isContainedRealPath(workDir, repoDir)) {
    throw new UnsafeCheckoutError(repoDir, "the checkout is not a plain directory inside the workspace");
  }
  const gitDir = join(repoDir, ".git");
  const gitKind = lstatKind(gitDir);
  if (gitKind === "absent") return;
  if (gitKind !== "dir") throw new UnsafeCheckoutError(repoDir, ".git is not a plain directory");
  if (lstatKind(join(gitDir, "commondir")) !== "absent") {
    throw new UnsafeCheckoutError(repoDir, ".git borrows another repository through commondir");
  }

  removeSymlinksUnder(gitDir);
  for (const f of ["alternates", "http-alternates"]) {
    try { unlinkSync(join(gitDir, "objects", "info", f)); } catch { /* absent */ }
  }
  writeWorkspaceFile(gitDir, "config", cleanConfig(readWorkspaceFile(gitDir, "config"), originUrl));
}

function lstatKind(path: string): "absent" | "dir" | "other" {
  try {
    return lstatSync(path).isDirectory() ? "dir" : "other";
  } catch {
    return "absent";
  }
}

function cleanConfig(current: string | null, originUrl: string): string {
  const fetch: string[] = [];
  const branches = new Map<string, string>();
  for (const line of readKeys(current)) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "remote.origin.fetch") {
      const m = /^\+?refs\/heads\/(.+):refs\/remotes\/origin\/(.+)$/.exec(value);
      const ok = value === DEFAULT_FETCH || (m && SAFE_REF.test(m[1]) && SAFE_REF.test(m[2]));
      if (ok && !fetch.includes(value)) fetch.push(value);
    } else if (key.startsWith("branch.") && key.endsWith(".merge")) {
      const name = key.slice("branch.".length, -".merge".length);
      if (SAFE_REF.test(name) && value.startsWith("refs/heads/") && SAFE_REF.test(value)) branches.set(name, value);
    }
  }
  if (fetch.length === 0) fetch.push(DEFAULT_FETCH);

  const lines = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
    '[remote "origin"]',
    `\turl = ${originUrl}`,
    ...fetch.map((f) => `\tfetch = ${f}`),
  ];
  for (const [name, merge] of branches) {
    lines.push(`[branch "${name}"]`, "\tremote = origin", `\tmerge = ${merge}`);
  }
  return lines.join("\n") + "\n";
}

// Parsed by git itself, from stdin, with includes off and outside any repository.
function readKeys(config: string | null): string[] {
  if (!config) return [];
  try {
    return execFileSync(
      "git",
      ["config", "--no-includes", "--file", "-", "--get-regexp", "^(remote\\.origin\\.fetch|branch\\..*\\.merge)$"],
      { input: config, cwd: "/", encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 15_000 },
    ).split("\n");
  } catch {
    return [];
  }
}
