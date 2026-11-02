import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// A run that crashed between hand-overs leaves its workspace owned by the
// sandbox's `agent` subuid on rootless docker. Reap and the next run's reuse
// must take it back through a container before touching it from the host.

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFileSync: vi.fn().mockReturnValue("") };
});

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

import { execFileSync } from "child_process";
import { hasLiveSandboxFor, reapSandboxWorkspace, reclaimWorkspaceDir, sandboxRoot } from "#src/sandbox/reap.js";
import { ensureWorkspaceDir, WorkspaceBusyError } from "#src/sandbox/index.js";

const mockExec = vi.mocked(execFileSync);
const tmps: string[] = [];
const lockedDirs: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

/** A workspace whose subdir the host cannot delete from (stands in for subuid-owned files). */
function lockedWorkspace(stateDir: string, taskId: string): { dir: string; locked: string } {
  const dir = join(sandboxRoot(stateDir), taskId);
  const locked = join(dir, "repo");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "f.txt"), "x");
  chmodSync(locked, 0o500);
  lockedDirs.push(locked);
  return { dir, locked };
}

let prevRootless: string | undefined;
let prevDataVolume: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue("");
  prevRootless = process.env.SANDBOX_ROOTLESS;
  prevDataVolume = process.env.SANDBOX_DATA_VOLUME;
});
afterEach(() => {
  if (prevRootless === undefined) delete process.env.SANDBOX_ROOTLESS;
  else process.env.SANDBOX_ROOTLESS = prevRootless;
  if (prevDataVolume === undefined) delete process.env.SANDBOX_DATA_VOLUME;
  else process.env.SANDBOX_DATA_VOLUME = prevDataVolume;
  for (const d of lockedDirs.splice(0)) {
    try { chmodSync(d, 0o700); } catch { /* already removed */ }
  }
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("reclaimWorkspaceDir", () => {
  it("chowns the tree back to container root from a capped, offline container", () => {
    reclaimWorkspaceDir({ type: "bind", hostPath: "/state/sandboxes/t1" }, "lastlight-sandbox:latest");
    expect(mockExec).toHaveBeenCalledWith(
      "docker",
      [
        "run", "--rm", "--network", "none",
        "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
        "--entrypoint", "chown",
        "-v", "/state/sandboxes/t1:/w",
        "lastlight-sandbox:latest",
        "-R", "-h", "-P", "0:0", "/w",
      ],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("throws when the container fails", () => {
    mockExec.mockImplementation(() => { throw new Error("no such image"); });
    expect(() => reclaimWorkspaceDir({ type: "bind", hostPath: "/x" }, "img")).toThrow(/no such image/);
  });

  it("mounts the same volume subpath the sandbox used when the data dir is a named volume", () => {
    reclaimWorkspaceDir({ type: "volume-subpath", volume: "lastlight_agent-data", subpath: "sandboxes/t1" }, "img");
    const argv = mockExec.mock.calls[0][1] as string[];
    expect(argv).toContain("--mount");
    expect(argv[argv.indexOf("--mount") + 1]).toBe(
      "type=volume,source=lastlight_agent-data,target=/w,volume-subpath=sandboxes/t1",
    );
    expect(argv).not.toContain("-v");
  });
});

describe("reapSandboxWorkspace on rootless docker", () => {
  it("reclaims then retries when the host cannot remove the workspace", () => {
    const stateDir = tmp("reclaim-state-");
    const { dir, locked } = lockedWorkspace(stateDir, "acme-1-build");
    const reclaim = vi.fn((d: string) => { expect(d).toBe(dir); chmodSync(locked, 0o700); });
    const res = reapSandboxWorkspace({ taskId: "acme-1-build", stateDir, isLive: () => false, reclaim });
    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ removed: true });
    expect(existsSync(dir)).toBe(false);
  });

  it("uses the sandbox image by default when SANDBOX_ROOTLESS=1", () => {
    process.env.SANDBOX_ROOTLESS = "1";
    const stateDir = tmp("reclaim-state-");
    process.env.SANDBOX_DATA_VOLUME = stateDir; // path mode → bind mount
    const { dir, locked } = lockedWorkspace(stateDir, "acme-2-build");
    mockExec.mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === "docker" && args[0] === "run") chmodSync(locked, 0o700);
      return "";
    }) as unknown as typeof execFileSync);
    const res = reapSandboxWorkspace({ taskId: "acme-2-build", stateDir, isLive: () => false });
    const run = mockExec.mock.calls.find((c) => (c[1] as string[])[0] === "run");
    expect(run?.[1]).toContain(`${dir}:/w`);
    expect(run?.[1]).toContain("lastlight-sandbox:latest");
    expect(res.removed).toBe(true);
  });

  it("without SANDBOX_ROOTLESS a permission error is reported, with no docker run", () => {
    delete process.env.SANDBOX_ROOTLESS;
    const stateDir = tmp("reclaim-state-");
    lockedWorkspace(stateDir, "acme-3-build");
    const res = reapSandboxWorkspace({ taskId: "acme-3-build", stateDir, isLive: () => false });
    expect(res).toEqual({ removed: false, reason: "error" });
    expect(mockExec.mock.calls.some((c) => (c[1] as string[])[0] === "run")).toBe(false);
  });

  it("a failed reclaim keeps reap's never-throw contract", () => {
    const stateDir = tmp("reclaim-state-");
    lockedWorkspace(stateDir, "acme-4-build");
    const reclaim = vi.fn(() => { throw new Error("daemon down"); });
    const res = reapSandboxWorkspace({ taskId: "acme-4-build", stateDir, isLive: () => false, reclaim });
    expect(res).toEqual({ removed: false, reason: "error" });
  });
});

describe("ensureWorkspaceDir", () => {
  it("reclaims an existing workspace before the host reuses it", () => {
    const dir = tmp("ws-");
    const reclaim = vi.fn();
    ensureWorkspaceDir(dir, reclaim);
    expect(reclaim).toHaveBeenCalledWith(dir);
  });

  it("creates a fresh workspace without reclaiming", () => {
    const dir = join(tmp("ws-parent-"), "fresh");
    const reclaim = vi.fn();
    ensureWorkspaceDir(dir, reclaim);
    expect(existsSync(dir)).toBe(true);
    expect(reclaim).not.toHaveBeenCalled();
  });

  it("refuses a workspace another live sandbox container owns, without touching it", () => {
    const dir = tmp("ws-");
    const reclaim = vi.fn();
    expect(() => ensureWorkspaceDir(dir, reclaim, () => true)).toThrow(WorkspaceBusyError);
    expect(reclaim).not.toHaveBeenCalled();
  });

  it("keeps upstream behaviour (no busy refusal) when not on rootless docker", () => {
    const dir = tmp("ws-");
    expect(() => ensureWorkspaceDir(dir, undefined, () => true)).not.toThrow();
  });

  it("does nothing extra when no reclaim is given", () => {
    const dir = tmp("ws-");
    expect(() => ensureWorkspaceDir(dir)).not.toThrow();
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("hasLiveSandboxFor", () => {
  it("matches this task's sandbox containers exactly, not a task whose id merely extends it", () => {
    mockExec.mockReturnValue("lastlight-sandbox-acme-12-1234abcd\n");
    expect(hasLiveSandboxFor("acme-1")).toBe(false);
    mockExec.mockReturnValue("lastlight-sandbox-acme-12-1234abcd\nlastlight-sandbox-acme-1-deadbeef\n");
    expect(hasLiveSandboxFor("acme-1")).toBe(true);
  });

  it("treats an unreachable docker as no live sandbox", () => {
    mockExec.mockImplementation(() => { throw new Error("no daemon"); });
    expect(hasLiveSandboxFor("acme-1")).toBe(false);
  });
});
