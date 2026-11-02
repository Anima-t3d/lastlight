import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

import { UnsafeCheckoutError, hostGit, sanitizeCheckout } from "#src/engine/host-git.js";

// Host-side git runs as the server's user on a checkout the agent has written
// to. Anything git reads from that checkout's `.git/` — hooks, config, a
// gitfile — must not be able to run a program on the host or point git at a
// host path.

const ORIGIN = "https://github.com/acme/app.git";
let base: string;
let ws: string;
let repo: string;
let marker: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
const localConfig = () => git("config", "--local", "--list", "--no-includes");

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "host-git-"));
  ws = join(base, "ws");
  repo = join(ws, "app");
  marker = join(base, "PWNED");
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "feat/x");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git("remote", "add", "origin", ORIGIN);
  git("config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  git("config", "branch.feat/x.remote", "origin");
  git("config", "branch.feat/x.merge", "refs/heads/feat/x");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function evilScript(): string {
  const script = join(base, "evil.sh");
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(script, 0o755);
  return script;
}

describe("hostGit", () => {
  it("never runs a hook the agent planted in .git/hooks", () => {
    const hook = join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);
    hostGit(repo, ["checkout", "-q", "-B", "other"]);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("sanitizeCheckout", () => {
  it("rewrites a hostile .git/config down to the keys the harness set", () => {
    const evil = evilScript();
    git("config", "core.hooksPath", base);
    git("config", "core.fsmonitor", evil);
    git("config", "diff.external", evil);
    git("config", "core.worktree", base);
    git("config", "url.https://evil.example/.insteadOf", "https://github.com/");
    git("config", "include.path", join(base, "more.cfg"));
    git("config", "filter.x.smudge", evil);
    git("config", "remote.origin.url", "https://evil.example/app.git");
    git("config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");

    sanitizeCheckout(ws, repo, ORIGIN);

    const cfg = localConfig();
    for (const key of ["hookspath", "fsmonitor", "diff.external", "worktree", "insteadof", "include.path", "filter.x"]) {
      expect(cfg).not.toContain(key);
    }
    expect(git("config", "--get", "remote.origin.url").trim()).toBe(ORIGIN);
    expect(git("config", "--get-all", "remote.origin.fetch").trim().split("\n")).toEqual([
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
    expect(git("config", "--get", "branch.feat/x.merge").trim()).toBe("refs/heads/feat/x");
  });

  it("leaves no way for a later diff or clean to run a program or leave the checkout", () => {
    const evil = evilScript();
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "k");
    writeFileSync(join(repo, "tracked.txt"), "a");
    git("add", "tracked.txt");
    writeFileSync(join(repo, "tracked.txt"), "b");
    git("config", "diff.external", evil);
    git("config", "core.worktree", outside);

    sanitizeCheckout(ws, repo, ORIGIN);
    hostGit(repo, ["diff"], { stdio: "pipe" });
    hostGit(repo, ["clean", "-fdx"], { stdio: "pipe" });

    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
  });

  it("removes symlinks and object alternates under .git", () => {
    symlinkSync(join(base, "secret"), join(repo, ".git", "refs", "heads", "leak"));
    writeFileSync(join(repo, ".git", "objects", "info", "alternates"), `${base}\n`);
    sanitizeCheckout(ws, repo, ORIGIN);
    expect(existsSync(join(repo, ".git", "refs", "heads", "leak"))).toBe(false);
    expect(existsSync(join(repo, ".git", "objects", "info", "alternates"))).toBe(false);
  });

  it("refuses a .git gitfile pointing at another repository", () => {
    rmSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git"), `gitdir: ${join(base, "elsewhere")}\n`);
    expect(() => sanitizeCheckout(ws, repo, ORIGIN)).toThrow(UnsafeCheckoutError);
  });

  it("refuses a symlinked .git", () => {
    const real = join(base, "real-git");
    execFileSync("mv", [join(repo, ".git"), real]);
    symlinkSync(real, join(repo, ".git"));
    expect(() => sanitizeCheckout(ws, repo, ORIGIN)).toThrow(UnsafeCheckoutError);
  });

  it("refuses a .git that borrows another repository through commondir", () => {
    writeFileSync(join(repo, ".git", "commondir"), `${base}\n`);
    expect(() => sanitizeCheckout(ws, repo, ORIGIN)).toThrow(UnsafeCheckoutError);
  });

  it("refuses a checkout dir the agent replaced with a symlink out of the workspace", () => {
    const hostRepo = join(base, "host-repo");
    execFileSync("mv", [repo, hostRepo]);
    symlinkSync(hostRepo, repo);
    expect(() => sanitizeCheckout(ws, repo, ORIGIN)).toThrow(UnsafeCheckoutError);
  });

  it("is a no-op when there is no checkout yet", () => {
    rmSync(repo, { recursive: true });
    expect(() => sanitizeCheckout(ws, repo, ORIGIN)).not.toThrow();
    mkdirSync(repo);
    expect(() => sanitizeCheckout(ws, repo, ORIGIN)).not.toThrow();
  });

  it("treats a FIFO config as absent instead of blocking", () => {
    rmSync(join(repo, ".git", "config"));
    execFileSync("mkfifo", [join(repo, ".git", "config")]);
    sanitizeCheckout(ws, repo, ORIGIN);
    expect(lstatSync(join(repo, ".git", "config")).isFile()).toBe(true);
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).toContain(ORIGIN);
  });
});
