/** The 20-minute backstop sweep over open build PRs in merge-listed repos. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { runBuildMergeSweep, buildCronHandlers, BUILD_MERGE_CRON } from "#src/cron/handlers.js";
import {
  resetRuntimeConfigForTests,
  setAutonomyReposOverride,
  setMergeReposOverride,
} from "#src/config/config.js";
import { CronWorkflowSchema } from "lastlight-workflow-engine";

const BOT = "last-light[bot]";

function pr(number: number, authorLogin: string) {
  return { number, title: "", draft: false, authorLogin, labels: [], headRef: "", headSha: "", createdAt: "" };
}

function fakeGithub(prs: Record<string, ReturnType<typeof pr>[]>) {
  return {
    listOpenPullRequests: vi.fn(async (owner: string, repo: string) => {
      const list = prs[`${owner}/${repo}`];
      if (!list) throw new Error(`no such repo ${owner}/${repo}`);
      return list;
    }),
  };
}

beforeEach(() => {
  setAutonomyReposOverride(["acme/a", "acme/b"]);
  setMergeReposOverride(["acme/a", "acme/c"]);
});
afterEach(() => {
  resetRuntimeConfigForTests();
  setMergeReposOverride(null);
});

describe("runBuildMergeSweep", () => {
  it("evaluates only bot-authored open PRs, only in repos on BOTH lists, with trigger sweep", async () => {
    const github = fakeGithub({
      "acme/a": [pr(1, BOT), pr(2, "ada"), pr(3, BOT)],
      "acme/b": [pr(4, BOT)],
      "acme/c": [pr(5, BOT)],
    });
    const evaluate = vi.fn(async () => ({ decision: "wait" as const, reason: "x: y" }));
    await runBuildMergeSweep({ github: github as any, db: {} as any, botLogin: BOT, evaluate }, {});
    // acme/b is autonomous but not merge-listed; acme/c is merge-listed but not autonomous.
    expect(github.listOpenPullRequests.mock.calls.map((c) => `${c[0]}/${c[1]}`)).toEqual(["acme/a"]);
    expect(evaluate.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      ["acme/a", 1, "sweep"],
      ["acme/a", 3, "sweep"],
    ]);
  });

  it("runs PRs one at a time", async () => {
    const github = fakeGithub({ "acme/a": [pr(1, BOT), pr(3, BOT)] });
    let active = 0;
    let peak = 0;
    const evaluate = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { decision: "wait" as const, reason: "x: y" };
    });
    await runBuildMergeSweep({ github: github as any, db: {} as any, botLogin: BOT, evaluate }, {});
    expect(peak).toBe(1);
  });

  it("one failing PR does not stop the others, and the tick reports the failure after", async () => {
    setMergeReposOverride(["acme/a", "acme/b"]);
    const github = fakeGithub({ "acme/a": [pr(1, BOT), pr(3, BOT)], "acme/b": [pr(4, BOT)] });
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new Error("502"))
      .mockResolvedValue({ decision: "wait", reason: "x: y" });
    await expect(
      runBuildMergeSweep({ github: github as any, db: {} as any, botLogin: BOT, evaluate }, {}),
    ).rejects.toThrow(/1 failure\(s\) across 3 PR\(s\)/);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it("is a no-op when no repo is on both lists", async () => {
    setMergeReposOverride([]);
    const github = fakeGithub({});
    const evaluate = vi.fn();
    await runBuildMergeSweep({ github: github as any, db: {} as any, botLogin: BOT, evaluate }, {});
    expect(github.listOpenPullRequests).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe("build-merge cron registration", () => {
  it("registers the handler only when a GitHub client is available", () => {
    expect(buildCronHandlers({ db: {} as any })[BUILD_MERGE_CRON]).toBeUndefined();
    const reg = buildCronHandlers({ db: {} as any, buildMerge: { github: {} as any, botLogin: BOT } });
    expect(typeof reg[BUILD_MERGE_CRON]).toBe("function");
  });

  it("ships workflows/cron-build-merge.yaml every 20 minutes, naming the handler", () => {
    const raw = parseYaml(readFileSync(join(__dirname, "../../workflows/cron-build-merge.yaml"), "utf8"));
    const parsed = CronWorkflowSchema.parse(raw);
    expect(parsed.schedule).toBe("*/20 * * * *");
    expect(parsed.handler).toBe(BUILD_MERGE_CRON);
    expect(parsed.name).toBe(BUILD_MERGE_CRON);
  });
});
