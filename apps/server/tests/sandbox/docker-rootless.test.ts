import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// Rootless docker maps the sandbox's `agent` (uid 10001) to a subuid, so the
// host user can no longer write the workspace once the entrypoint chowns it.
// These tests pin the hand-over: the agent owns the workspace only while a run
// is executing, and the host owns it the rest of the time.

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
    execFileSync: vi.fn().mockReturnValue("container-xyz\n"),
    execFile: vi.fn((_cmd: string, _args: string[], opts: unknown, cb?: unknown) => {
      const done = (typeof opts === "function" ? opts : cb) as (e: unknown, r: unknown) => void;
      done(null, { stdout: "", stderr: "" });
    }),
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true), readFileSync: vi.fn().mockReturnValue("{}") };
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

import { spawn, execFile, execFileSync } from "child_process";
import { DockerSandbox, WorkspaceHeldError } from "#src/sandbox/docker.js";

const mockSpawn = vi.mocked(spawn);
const mockExecFile = vi.mocked(execFile);
const mockExecFileSync = vi.mocked(execFileSync);

const TO_HOST = ["exec", "-u", "0", "test-container", "chown", "-R", "-h", "-P", "0:0", "/home/agent/workspace"];
const TO_AGENT = ["exec", "-u", "0", "test-container", "chown", "-R", "-h", "-P", "agent:agent", "/home/agent/workspace"];
const RUN = { timeoutSeconds: 5, gateTimeoutSeconds: 900 };

function makeFakeChild() {
  const stdin = { write: vi.fn(), end: vi.fn() };
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: vi.fn() });
  return child as unknown as ReturnType<typeof spawn> & { stdout: typeof stdout };
}

/** Every docker invocation, in order: `chown:<spec>` for ownership execs, `spawn` for agent/command execs. */
let events: string[];

function record() {
  mockExecFile.mockImplementation(((_cmd: string, args: string[], opts: unknown, cb?: unknown) => {
    const done = (typeof opts === "function" ? opts : cb) as (e: unknown, r: unknown) => void;
    if (args.includes("chown")) events.push(`chown:${args[args.length - 2]}`);
    done(null, { stdout: "", stderr: "" });
  }) as unknown as typeof execFile);
}

function sandbox(rootless: boolean): DockerSandbox {
  const s = new DockerSandbox({ imageName: "test-image", env: {}, rootless });
  (s as unknown as { activeContainers: Map<string, unknown> }).activeContainers.set("task-001", {
    containerId: "abc123",
    containerName: "test-container",
    worktreePath: "/tmp/work",
  });
  return s;
}

function chownCalls(): string[][] {
  return mockExecFile.mock.calls.map((c) => c[1] as string[]).filter((a) => a.includes("chown"));
}

describe("DockerSandbox on rootless docker — workspace ownership", () => {
  let children: ReturnType<typeof makeFakeChild>[];

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    children = [];
    record();
    mockSpawn.mockImplementation((() => {
      events.push("spawn");
      const c = makeFakeChild();
      children.push(c);
      return c;
    }) as unknown as typeof spawn);
  });

  it("create() hands the workspace to the host once the entrypoint is ready", async () => {
    const s = new DockerSandbox({ imageName: "img", env: {}, rootless: true });
    const info = await s.create({
      taskId: "t",
      worktreePath: "/tmp/work",
      workspaceMount: { type: "bind", hostPath: "/tmp/work" },
    });
    const last = mockExecFile.mock.calls.at(-1)?.[1] as string[];
    expect(last).toEqual(["exec", "-u", "0", info.containerName, "chown", "-R", "-h", "-P", "0:0", "/home/agent/workspace"]);
  });

  it("runAgent() gives the workspace to agent before the exec and back after close", async () => {
    const s = sandbox(true);
    const run = s.runAgent("task-001", "hi", RUN);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("close", 0);
    await run;
    expect(events).toEqual(["chown:agent:agent", "spawn", "chown:0:0"]);
    expect(chownCalls()).toEqual([TO_AGENT, TO_HOST]);
  });

  it("runAgent() hands the workspace back when the agent exits non-zero", async () => {
    const s = sandbox(true);
    const run = s.runAgent("task-001", "hi", RUN);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("close", 3);
    await expect(run).rejects.toThrow(/exit 3/);
    expect(events).toEqual(["chown:agent:agent", "spawn", "chown:0:0"]);
  });

  it("runAgent() hands the workspace back when the run times out", async () => {
    vi.useFakeTimers();
    try {
      const s = sandbox(true);
      const run = s.runAgent("task-001", "hi", { timeoutSeconds: 1, gateTimeoutSeconds: 900 });
      const settled = expect(run).rejects.toThrow(/timed out/);
      await vi.waitFor(() => expect(children).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(1500);
      await settled;
      expect(events).toEqual(["chown:agent:agent", "spawn", "chown:0:0"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runCommand() is bracketed the same way", async () => {
    const s = sandbox(true);
    const run = s.runCommand("task-001", "true", { timeoutSeconds: 5 });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("close", 0);
    await run;
    expect(events).toEqual(["chown:agent:agent", "spawn", "chown:0:0"]);
  });

  it("overlapping runs on one task flip ownership once each way", async () => {
    const s = sandbox(true);
    const a = s.runAgent("task-001", "a", RUN);
    const b = s.runCommand("task-001", "true", { timeoutSeconds: 5 });
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[0].emit("close", 0);
    await a;
    expect(events.filter((e) => e === "chown:0:0")).toHaveLength(0);
    children[1].emit("close", 0);
    await b;
    expect(events.filter((e) => e === "chown:agent:agent")).toHaveLength(1);
    expect(events.filter((e) => e === "chown:0:0")).toHaveLength(1);
    expect(events.at(-1)).toBe("chown:0:0");
  });

  it("an overlapping run does not start before the hand-over to agent has finished", async () => {
    let finishHandOver: (() => void) | undefined;
    mockExecFile.mockImplementation(((_cmd: string, args: string[], opts: unknown, cb?: unknown) => {
      const done = (typeof opts === "function" ? opts : cb) as (e: unknown, r: unknown) => void;
      if (args.includes("agent:agent")) {
        finishHandOver = () => {
          events.push("chown:agent:agent");
          done(null, { stdout: "", stderr: "" });
        };
        return;
      }
      if (args.includes("chown")) events.push(`chown:${args[args.length - 2]}`);
      done(null, { stdout: "", stderr: "" });
    }) as unknown as typeof execFile);
    const s = sandbox(true);
    const a = s.runAgent("task-001", "a", RUN);
    const b = s.runCommand("task-001", "true", { timeoutSeconds: 5 });
    await vi.waitFor(() => expect(finishHandOver).toBeDefined());
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
    finishHandOver!();
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(events.slice(0, 3)).toEqual(["chown:agent:agent", "spawn", "spawn"]);
    children[0].emit("close", 0);
    children[1].emit("close", 0);
    await Promise.all([a, b]);
  });

  it("a run arriving during a hand-back waits for it before taking the workspace", async () => {
    let finishHandBack: (() => void) | undefined;
    mockExecFile.mockImplementation(((_cmd: string, args: string[], opts: unknown, cb?: unknown) => {
      const done = (typeof opts === "function" ? opts : cb) as (e: unknown, r: unknown) => void;
      if (args.includes("0:0") && !finishHandBack) {
        events.push("chown:0:0:start");
        finishHandBack = () => {
          events.push("chown:0:0:end");
          done(null, { stdout: "", stderr: "" });
        };
        return;
      }
      if (args.includes("chown")) events.push(`chown:${args[args.length - 2]}`);
      done(null, { stdout: "", stderr: "" });
    }) as unknown as typeof execFile);
    const s = sandbox(true);
    const first = s.runAgent("task-001", "a", RUN);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("close", 0);
    await vi.waitFor(() => expect(finishHandBack).toBeDefined());
    const second = s.runCommand("task-001", "true", { timeoutSeconds: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e === "chown:agent:agent")).toHaveLength(1);
    finishHandBack!();
    await first;
    await vi.waitFor(() => expect(children).toHaveLength(2));
    const end = events.indexOf("chown:0:0:end");
    expect(events.indexOf("chown:agent:agent", end)).toBeGreaterThan(end);
    children[1].emit("close", 0);
    await second;
  });

  it("the hand-back first kills the agent's leftover processes, sparing PID 1", async () => {
    const s = sandbox(true);
    const run = s.runAgent("task-001", "hi", RUN);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("close", 0);
    await run;
    const calls = mockExecFile.mock.calls.map((c) => c[1] as string[]);
    const kill = calls.findIndex((a) => a[0] === "exec" && a.includes("sh") && a.join(" ").includes("kill -9"));
    const back = calls.findIndex((a) => a.includes("0:0"));
    expect(kill).toBeGreaterThan(-1);
    expect(kill).toBeLessThan(back);
    expect(calls[kill].slice(0, 4)).toEqual(["exec", "-u", "0", "test-container"]);
    expect(calls[kill].at(-1)).toMatch(/\[ "\$p" = 1 \] && continue/);
  });

  it("reports a held workspace while a run executes, and a free one after", async () => {
    const s = sandbox(true);
    expect(() => s.assertWorkspaceFree("task-001")).not.toThrow();
    const run = s.runAgent("task-001", "hi", RUN);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(() => s.assertWorkspaceFree("task-001")).toThrow(WorkspaceHeldError);
    children[0].emit("close", 0);
    await run;
    expect(() => s.assertWorkspaceFree("task-001")).not.toThrow();
  });

  it("without rootless no ownership exec is issued", async () => {
    const s = sandbox(false);
    const run = s.runAgent("task-001", "hi", RUN);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("close", 0);
    await run;
    expect(chownCalls()).toEqual([]);
    expect(events).toEqual(["spawn"]);
  });

  it("a failed hand-back rejects the run and names the container", async () => {
    mockExecFile.mockImplementation(((_cmd: string, args: string[], opts: unknown, cb?: unknown) => {
      const done = (typeof opts === "function" ? opts : cb) as (e: unknown, r: unknown) => void;
      if (args.includes("0:0")) return done(new Error("chown: permission denied"), { stdout: "", stderr: "" });
      done(null, { stdout: "", stderr: "" });
    }) as unknown as typeof execFile);
    const s = sandbox(true);
    const run = s.runAgent("task-001", "hi", RUN);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("close", 0);
    await expect(run).rejects.toThrow(/test-container/);
  });

  it("a failed hand-back after a failed run keeps the run's own error as the cause", async () => {
    failHandBack();
    const s = sandbox(true);
    const run = s.runAgent("task-001", "hi", RUN);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("close", 3);
    const err = await run.catch((e: Error) => e);
    expect((err as Error).message).toMatch(/test-container/);
    expect(((err as Error).cause as Error | undefined)?.message).toMatch(/exit 3/);
  });

  it("a failed hand-back in create() removes the container it started", async () => {
    failHandBack();
    const s = new DockerSandbox({ imageName: "img", env: {}, rootless: true });
    await expect(s.create({
      taskId: "t",
      worktreePath: "/tmp/work",
      workspaceMount: { type: "bind", hostPath: "/tmp/work" },
    })).rejects.toThrow(/Failed to create sandbox/);
    const removed = mockExecFileSync.mock.calls
      .map((c) => c[1] as string[])
      .filter((a) => a[0] === "rm" && a[1] === "-f");
    expect(removed).toHaveLength(1);
    expect(removed[0][2]).toMatch(/^lastlight-sandbox-t-/);
  });
});

/** Make every `chown … 0:0` (the hand-back to the host) fail. */
function failHandBack(): void {
  mockExecFile.mockImplementation(((_cmd: string, args: string[], opts: unknown, cb?: unknown) => {
    const done = (typeof opts === "function" ? opts : cb) as (e: unknown, r: unknown) => void;
    if (args.includes("0:0")) return done(new Error("chown: permission denied"), { stdout: "", stderr: "" });
    done(null, { stdout: "", stderr: "" });
  }) as unknown as typeof execFile);
}
