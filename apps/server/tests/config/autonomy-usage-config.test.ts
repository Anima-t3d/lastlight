import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { defaultAutonomyConfig, loadConfig, redactPublic, resetRuntimeConfigForTests } from "#src/config/config.js";

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

function overlayWith(block: string): string {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-usage-"));
  writeFileSync(join(dir, "config.yaml"), block);
  return dir;
}

describe("the packaged usage gate", () => {
  it("ships off (no source), with the documented defaults", () => {
    expect(defaultAutonomyConfig().budget.usage).toEqual({
      source: null,
      maxPercent: 80,
      windows: ["five_hour", "weekly"],
      staleAfterSeconds: 600,
      onUnavailable: "allow",
      enabled: true,
    });
  });

  it("keeps the shipped dollar caps", () => {
    expect(defaultAutonomyConfig().budget.dailyUsd).toBe(25);
    expect(defaultAutonomyConfig().budget.repoDailyUsd).toBe(10);
  });
});

describe("loadConfig — autonomy.budget.usage", () => {
  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) vi.stubEnv(k, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  const load = (yaml: string) => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith(yaml));
    return loadConfig().autonomy.budget;
  };

  it("reads a file source and overrides", () => {
    const b = load(
      "autonomy:\n  budget:\n    usage:\n      source: { file: /run/usage.json }\n      maxPercent: 90\n      windows: [five_hour]\n      staleAfterSeconds: 120\n      onUnavailable: hold\n",
    );
    expect(b.usage).toEqual({
      source: { file: "/run/usage.json" },
      maxPercent: 90,
      windows: ["five_hour"],
      staleAfterSeconds: 120,
      onUnavailable: "hold",
      enabled: true,
    });
  });

  it("reads a command source as argv", () => {
    const b = load("autonomy:\n  budget:\n    usage:\n      source: { command: [/usr/bin/usage, --json] }\n");
    expect(b.usage.source).toEqual({ command: ["/usr/bin/usage", "--json"] });
  });

  it("a malformed source leaves the gate off", () => {
    for (const src of ["{ file: 3 }", "{ command: [] }", "{ command: /bin/sh -c x }", "{ url: http://x }", "yes"]) {
      expect(load(`autonomy:\n  budget:\n    usage:\n      source: ${src}\n`).usage.source).toBeNull();
    }
  });

  it("maxPercent outside 1–100 falls back to 80", () => {
    for (const v of ["0", "101", "-5", "x"]) {
      expect(load(`autonomy:\n  budget:\n    usage:\n      maxPercent: ${v}\n`).usage.maxPercent).toBe(80);
    }
  });

  it("an unknown onUnavailable falls back to allow; enabled: false is kept", () => {
    const b = load("autonomy:\n  budget:\n    usage:\n      onUnavailable: maybe\n      enabled: false\n");
    expect(b.usage.onUnavailable).toBe("allow");
    expect(b.usage.enabled).toBe(false);
  });

  it("an empty or malformed windows list falls back to the default", () => {
    expect(load("autonomy:\n  budget:\n    usage:\n      windows: []\n").usage.windows).toEqual(["five_hour", "weekly"]);
  });

  it("dailyUsd: null means no dollar cap; a negative still falls back to the packaged value", () => {
    const b = load("autonomy:\n  budget:\n    dailyUsd: null\n    repoDailyUsd: -1\n");
    expect(b.dailyUsd).toBeNull();
    expect(b.repoDailyUsd).toBe(10);
  });
});

describe("redactPublic — autonomy.budget.usage.source", () => {
  it("shows only the source kind, never a path or argv", () => {
    const shown = redactPublic({
      autonomy: { budget: { usage: { source: { command: ["usage-cli", "--key", "abc123"] }, maxPercent: 80 } } },
      other: { usage: { source: { file: "/srv/usage.json" } } },
    });
    expect(shown.autonomy.budget.usage).toEqual({ source: "command", maxPercent: 80 });
    expect(JSON.stringify(shown)).not.toContain("abc123");
    expect(JSON.stringify(shown)).toContain("/srv/usage.json");
  });

  it("leaves a missing source as it is", () => {
    expect(redactPublic({ autonomy: { budget: { usage: { source: null } } } })).toEqual({
      autonomy: { budget: { usage: { source: null } } },
    });
  });
});
