import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadConfig,
  getMergeConfig,
  mergeConfigForLayer,
  defaultMergeConfig,
  resolveMergeConfig,
  resetRuntimeConfigForTests,
  setRuntimeConfig,
} from "#src/config/config.js";

const DEFAULT_PROTECTED = [".github/**", ".lastlight/**", "**/CODEOWNERS"];

describe("defaultMergeConfig / getMergeConfig defaults", () => {
  afterEach(() => resetRuntimeConfigForTests());

  it("ships the decided values", () => {
    expect(defaultMergeConfig()).toEqual({
      method: "squash",
      minSettledChecks: 1,
      protectedPaths: DEFAULT_PROTECTED,
      holdLabels: ["do-not-merge"],
    });
  });

  it("getMergeConfig() answers the defaults with no boot config", () => {
    expect(getMergeConfig()).toEqual(defaultMergeConfig());
    expect(getMergeConfig("o/r")).toEqual(defaultMergeConfig());
  });
});

describe("mergeConfigForLayer — the gate's policy from a refreshed layer", () => {
  afterEach(() => resetRuntimeConfigForTests());

  it("folds the layer's merge: node onto the operator block, tighten only", () => {
    const cfg = mergeConfigForLayer({ config: { merge: { protectedPaths: ["migrations/**"], minSettledChecks: 3 } } });
    expect(cfg.protectedPaths).toEqual([...DEFAULT_PROTECTED, "migrations/**"]);
    expect(cfg.minSettledChecks).toBe(3);
  });

  it("no layer is the operator block", () => {
    expect(mergeConfigForLayer(undefined)).toEqual(defaultMergeConfig());
  });
});

describe("resolveMergeConfig — a repo layer may only tighten", () => {
  const op = defaultMergeConfig();

  it("unions protectedPaths and holdLabels with the repo's additions", () => {
    const got = resolveMergeConfig(op, {
      protectedPaths: ["infra/**", ".github/**"],
      holdLabels: ["wip"],
    });
    expect(got.protectedPaths).toEqual([...DEFAULT_PROTECTED, "infra/**"]);
    expect(got.holdLabels).toEqual(["do-not-merge", "wip"]);
  });

  it("a repo that omits .github/** still gets it (union, never replace)", () => {
    const got = resolveMergeConfig(op, { protectedPaths: ["docs/**"] });
    expect(got.protectedPaths).toEqual(expect.arrayContaining(DEFAULT_PROTECTED));
  });

  it("clamps minSettledChecks: 0 from a repo is raised to the operator value", () => {
    expect(resolveMergeConfig({ ...op, minSettledChecks: 2 }, { minSettledChecks: 0 }).minSettledChecks).toBe(2);
    expect(resolveMergeConfig(op, { minSettledChecks: 0 }).minSettledChecks).toBe(1);
  });

  it("a higher repo minSettledChecks wins", () => {
    expect(resolveMergeConfig(op, { minSettledChecks: 4 }).minSettledChecks).toBe(4);
  });

  it("method is always squash, whatever the repo says", () => {
    expect(resolveMergeConfig(op, { method: "rebase" }).method).toBe("squash");
  });

  it("ignores garbage without throwing", () => {
    const got = resolveMergeConfig(op, { protectedPaths: "x", holdLabels: [1, ""], minSettledChecks: "no" });
    expect(got).toEqual(op);
    expect(resolveMergeConfig(op, undefined)).toEqual(op);
  });
});

describe("loadConfig — the operator's merge block", () => {
  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  function overlay(block: string): string {
    const dir = mkdtempSync(join(tmpdir(), "merge-boot-"));
    writeFileSync(join(dir, "config.yaml"), block);
    return dir;
  }

  it("ships the defaults from config/default.yaml, visible in the /config view", () => {
    const cfg = loadConfig();
    expect(cfg.merge).toEqual(defaultMergeConfig());
    expect((cfg.publicConfig.merged as Record<string, unknown>).merge).toBeDefined();
  });

  it("an overlay raises minSettledChecks and the operator can add paths; getMergeConfig reads them", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlay("merge:\n  minSettledChecks: 3\n  protectedPaths: [deploy/**]\n  holdLabels: [hold]\n"),
    );
    const cfg = loadConfig();
    setRuntimeConfig(cfg);
    expect(cfg.merge.minSettledChecks).toBe(3);
    expect(getMergeConfig("o/r").protectedPaths).toEqual([...DEFAULT_PROTECTED, "deploy/**"]);
    expect(getMergeConfig("o/r").holdLabels).toEqual(["do-not-merge", "hold"]);
    expect(getMergeConfig().method).toBe("squash");
  });
});
