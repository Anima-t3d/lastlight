/**
 * `usage_gate_overrides` — the dashboard's runtime override of the usage
 * gate's `enabled` / `maxPercent`, following the cron-override pattern: the
 * config value is the default, a row wins, clearing it reverts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { StateDb } from "#src/state/db.js";
import type { MakeDb, SuiteOpts } from "../store-suite.js";

export function runUsageOverrideSuite(makeDb: MakeDb, _opts: SuiteOpts): void {
  describe("usage gate override", () => {
    let db: StateDb;
    beforeEach(async () => {
      db = await makeDb();
    });

    it("is null until set", async () => {
      expect(await db.getUsageOverride()).toBeNull();
    });

    it("stores a partial patch, leaving the other field null (= config value)", async () => {
      await db.setUsageOverride({ maxPercent: 95 }, "alice");
      const o = await db.getUsageOverride();
      expect(o).toMatchObject({ enabled: null, maxPercent: 95, updatedBy: "alice" });
      expect(Date.parse(o!.updatedAt)).not.toBeNaN();
    });

    it("merges a second patch and keeps the first field", async () => {
      await db.setUsageOverride({ maxPercent: 95 }, "alice");
      await db.setUsageOverride({ enabled: false }, "bob");
      expect(await db.getUsageOverride()).toMatchObject({ enabled: false, maxPercent: 95, updatedBy: "bob" });
    });

    it("clears back to no override", async () => {
      await db.setUsageOverride({ enabled: true, maxPercent: 50 }, "alice");
      await db.clearUsageOverride();
      expect(await db.getUsageOverride()).toBeNull();
    });
  });
}
