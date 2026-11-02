import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

// Every place the harness touches a workspace file between phases, with the
// agent having replaced that file (or a directory above it) by a symlink to a
// host file. None of them may read it into the run or write through it.

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { drainPrNotes, readVerifyScript } from "#src/engine/fix-harvest.js";
import {
  excludeFromGit,
  harvestArtifactsOut,
  stageArtifactsIn,
  stageScriptFile,
  stageSkillBundle,
  type ServerArtifacts,
} from "#src/engine/executors/shared.js";
import { __writeAgentContextForTest as writeAgentContext } from "#src/engine/executors/orchestrator.js";
import { BuildAssetStore } from "#src/state/build-assets.js";

let base: string;
let ws: string;
let repo: string;
let secret: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ws-links-"));
  ws = join(base, "ws");
  repo = join(ws, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  secret = join(base, "secret.pem");
  writeFileSync(secret, "TOP-SECRET");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const PROV = { at: "2026-11-02T00:00:00Z", runId: "r1", workflow: "pr-fix", phase: "fix" };
const untouched = () => expect(readFileSync(secret, "utf8")).toBe("TOP-SECRET");

describe("fix-harvest readers", () => {
  it("readVerifyScript ignores a symlinked .git/lastlight-verify.sh", () => {
    symlinkSync(secret, join(repo, ".git", "lastlight-verify.sh"));
    expect(readVerifyScript(repo)).toBeNull();
  });

  it("drainPrNotes ignores a symlinked journal and leaves its target alone", () => {
    // A host file that happens to parse as notes: following the link would put it in the PR.
    const hostFile = join(base, "host-notes");
    writeFileSync(hostFile, "finding: HOST CONTENT\n");
    symlinkSync(hostFile, join(repo, ".git", "lastlight-notes"));
    expect(drainPrNotes(repo, PROV)).toEqual([]);
    expect(readFileSync(hostFile, "utf8")).toBe("finding: HOST CONTENT\n");
  });

  it("drainPrNotes still drains a plain journal", () => {
    writeFileSync(join(repo, ".git", "lastlight-notes"), "finding: keep the cache\n");
    expect(drainPrNotes(repo, PROV)).toHaveLength(1);
    expect(existsSync(join(repo, ".git", "lastlight-notes"))).toBe(false);
  });
});

describe("excludeFromGit", () => {
  it("does not append through a symlinked .git/info/exclude", () => {
    mkdirSync(join(repo, ".git", "info"));
    symlinkSync(secret, join(repo, ".git", "info", "exclude"));
    excludeFromGit(repo, ".lastlight");
    untouched();
  });

  it("does not create through a symlinked .git/info", () => {
    symlinkSync(base, join(repo, ".git", "info"));
    excludeFromGit(repo, ".lastlight");
    expect(existsSync(join(base, "exclude"))).toBe(false);
  });
});

describe("skill and script staging", () => {
  function skill(): string {
    const dir = join(base, "skills-src", "pr-review");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "skill");
    return dir;
  }

  it("refuses to stage through a symlinked skill root, writing nothing outside", () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(ws, ".lastlight-skills"));
    expect(stageSkillBundle(ws, "review", [skill()], "copy")).toBeUndefined();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("replaces a symlinked phase bundle dir instead of deleting inside its target", () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "k");
    mkdirSync(join(ws, ".lastlight-skills"));
    symlinkSync(outside, join(ws, ".lastlight-skills", "review"));
    const staged = stageSkillBundle(ws, "review", [skill()], "copy");
    expect(staged).toHaveLength(1);
    expect(lstatSync(join(ws, ".lastlight-skills", "review")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("k");
  });

  it("stageScriptFile replaces a planted script symlink and refuses a symlinked script dir", () => {
    mkdirSync(join(ws, ".lastlight-scripts", "gate"), { recursive: true });
    symlinkSync(secret, join(ws, ".lastlight-scripts", "gate", "run.sh"));
    stageScriptFile(ws, ".lastlight-scripts/gate", "run.sh", "echo ok");
    expect(readFileSync(join(ws, ".lastlight-scripts", "gate", "run.sh"), "utf8")).toBe("echo ok");
    untouched();

    rmSync(join(ws, ".lastlight-scripts"), { recursive: true });
    symlinkSync(base, join(ws, ".lastlight-scripts"));
    expect(() => stageScriptFile(ws, ".lastlight-scripts/gate", "run.sh", "x")).toThrow();
    expect(existsSync(join(base, "gate"))).toBe(false);
  });
});

describe("AGENTS.md delivery", () => {
  it("replaces a planted AGENTS.md symlink and leaves its target alone", () => {
    symlinkSync(secret, join(ws, "AGENTS.md"));
    writeAgentContext(ws, "# persona");
    expect(lstatSync(join(ws, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(ws, "AGENTS.md"), "utf8")).toBe("# persona");
    untouched();
  });
});

describe("server-mode build assets", () => {
  const ref = { owner: "acme", repo: "app", issueKey: "issue-7" };

  function artifacts(): ServerArtifacts {
    const store = new BuildAssetStore(join(base, "store"));
    const seed = join(base, "seed");
    mkdirSync(seed);
    writeFileSync(join(seed, "plan.md"), "stored plan");
    store.harvestFrom(ref as never, seed);
    return { store, ref: ref as never, dir: join(repo, ".lastlight", "issue-7"), repoDir: repo };
  }

  it("staging never writes through a symlink the agent left in the doc dir", () => {
    const art = artifacts();
    mkdirSync(art.dir, { recursive: true });
    symlinkSync(secret, join(art.dir, "plan.md"));
    stageArtifactsIn(art);
    untouched();
    expect(readFileSync(join(art.dir, "plan.md"), "utf8")).toBe("stored plan");
  });

  it("staging refuses a symlinked .lastlight dir", () => {
    const art = artifacts();
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, ".lastlight"));
    stageArtifactsIn(art);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("harvest stores no symlinks, and skips a symlinked doc dir entirely", () => {
    const art = artifacts();
    mkdirSync(art.dir, { recursive: true });
    writeFileSync(join(art.dir, "notes.md"), "phase notes");
    symlinkSync(secret, join(art.dir, "leak.md"));
    harvestArtifactsOut(art);
    const staged = join(base, "restage");
    art.store.stageInto(ref as never, staged);
    expect(readdirSync(staged).sort()).toEqual(["notes.md"]);

    rmSync(join(repo, ".lastlight"), { recursive: true });
    const outside = join(base, "outside-docs");
    mkdirSync(outside);
    writeFileSync(join(outside, "stolen.md"), "host file");
    mkdirSync(join(repo, ".lastlight"));
    symlinkSync(outside, art.dir);
    harvestArtifactsOut(art);
    const again = join(base, "restage2");
    art.store.stageInto(ref as never, again);
    expect(readdirSync(again)).not.toContain("stolen.md");
  });
});

// A named pipe at a fixed path would block a plain open() until something
// opens the other end — freezing the harness's event loop, not just one run.
describe("planted FIFOs never block the harness", () => {
  const fifo = (path: string) => execFileSync("mkfifo", [path]);

  it("readVerifyScript and drainPrNotes treat a FIFO as missing", () => {
    fifo(join(repo, ".git", "lastlight-verify.sh"));
    fifo(join(repo, ".git", "lastlight-notes"));
    expect(readVerifyScript(repo)).toBeNull();
    expect(drainPrNotes(repo, PROV)).toEqual([]);
  });

  it("AGENTS.md delivery replaces a FIFO with a regular file", () => {
    fifo(join(ws, "AGENTS.md"));
    writeAgentContext(ws, "# persona");
    expect(lstatSync(join(ws, "AGENTS.md")).isFile()).toBe(true);
    expect(readFileSync(join(ws, "AGENTS.md"), "utf8")).toBe("# persona");
  });

  it("excludeFromGit skips a FIFO exclude file", () => {
    mkdirSync(join(repo, ".git", "info"));
    fifo(join(repo, ".git", "info", "exclude"));
    expect(() => excludeFromGit(repo, ".lastlight")).not.toThrow();
  });
});
