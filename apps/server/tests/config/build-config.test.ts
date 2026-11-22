import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadConfig,
  getBuildConfig,
  defaultBuildConfig,
  resetRuntimeConfigForTests,
} from "#src/config/config.js";

function boot(yaml: string) {
  for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) vi.stubEnv(k, "");
  const dir = mkdtempSync(join(tmpdir(), "build-config-"));
  writeFileSync(join(dir, "config.yaml"), yaml);
  vi.stubEnv("LASTLIGHT_OVERLAY_DIR", dir);
  return loadConfig();
}

describe("build: — the L3 escalation budget", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  // Escalation is off unless an operator opts in with `maxAttempts: 2` (I1):
  // nothing retries a failed build on upgrade.
  it("ships escalateAfterAttempt 1 and maxAttempts 1 (escalation off)", () => {
    expect(defaultBuildConfig()).toEqual({ escalateAfterAttempt: 1, maxAttempts: 1 });
    expect(getBuildConfig()).toEqual(defaultBuildConfig());
  });

  it("boots the packaged defaults from config/default.yaml", () => {
    const cfg = boot("managedRepos: []\n");
    expect(cfg.build).toEqual({ escalateAfterAttempt: 1, maxAttempts: 1 });
    expect(getBuildConfig()).toEqual({ escalateAfterAttempt: 1, maxAttempts: 1 });
  });

  it("an overlay may change both; garbage falls back to the default", () => {
    expect(boot("build:\n  escalateAfterAttempt: 0\n  maxAttempts: 3\n").build).toEqual({
      escalateAfterAttempt: 0,
      maxAttempts: 3,
    });
    expect(boot("build:\n  escalateAfterAttempt: -1\n  maxAttempts: nope\n").build).toEqual({
      escalateAfterAttempt: 1,
      maxAttempts: 1,
    });
    // The opt-in an operator writes to turn escalation on.
    expect(boot("build:\n  maxAttempts: 2\n").build).toEqual({ escalateAfterAttempt: 1, maxAttempts: 2 });
  });

  it("ships no executor-retry / fix-retry model, so an unset key means no swap", () => {
    const cfg = boot("managedRepos: []\n");
    expect(cfg.models["executor-retry"]).toBeUndefined();
    expect(cfg.models["fix-retry"]).toBeUndefined();
  });
});
