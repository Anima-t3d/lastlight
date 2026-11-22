/** Table tests for the autonomous merge gate's pure decision. */
import { describe, it, expect } from "vitest";
import type { PrState } from "#src/engine/pr-state.js";
import type { MergeConfig } from "#src/config/config.js";
import {
  mayMergeBuild,
  globToRegExp,
  type BuildMergeInputs,
} from "#src/engine/merge-decisions.js";

const cfg: MergeConfig = {
  method: "squash",
  minSettledChecks: 1,
  protectedPaths: [".github/**", ".lastlight/**", "**/CODEOWNERS"],
  holdLabels: ["do-not-merge"],
};

function inputs(over: Partial<BuildMergeInputs> & { state?: Partial<PrState> } = {}): BuildMergeInputs {
  const { state, ...rest } = over;
  return {
    state: {
      prNumber: 7,
      headSha: "B",
      authorIsOurs: true,
      isDraft: false,
      baseRef: "main",
      labels: [],
      checksState: "passing",
      settledCheckCount: 3,
      ...state,
    } as PrState,
    review: {
      prNumber: 7,
      reviewedSha: "B",
      verdict: "APPROVED",
      verdictUrl: "u",
      recordedAt: "t",
    },
    changedPaths: ["src/a.ts"],
    issueNumber: 12,
    prLabels: [],
    issueLabels: [],
    holdLabel: "lastlight-ignore",
    mergeEnabled: true,
    fromBuildRun: true,
    mergeableState: "clean",
    baseIsDefault: true,
    ...rest,
  };
}

const rev = (o: object) => ({ prNumber: 7, reviewedSha: "B", verdict: "APPROVED" as const, verdictUrl: "u", recordedAt: "t", ...o });

const rows: Array<[string, BuildMergeInputs, "merge" | "wait" | "hand-off", string, MergeConfig?]> = [
  ["merge-disabled", inputs({ mergeEnabled: false }), "wait", "merge-disabled"],
  ["not-ours", inputs({ state: { authorIsOurs: false } }), "wait", "not-ours"],
  ["not-from-build", inputs({ fromBuildRun: false }), "wait", "not-from-build"],
  ["draft", inputs({ state: { isDraft: true } }), "wait", "draft"],
  ["not-default-base", inputs({ baseIsDefault: false }), "wait", "not-default-base"],
  ["hold-label", inputs({ prLabels: ["do-not-merge"] }), "hand-off", "hold-label"],
  // GitHub label names are case-insensitive, so the gate's matching is too.
  ["hold-label is case-insensitive", inputs({ prLabels: ["Do-Not-Merge"] }), "hand-off", "hold-label"],
  ["hold-label on the closing issue", inputs({ issueLabels: ["do-not-merge"] }), "hand-off", "hold-label"],
  // The instance hold label stops a merge like every other action (C1).
  ["instance hold label on an approved, green, clean PR", inputs({ prLabels: ["lastlight-ignore"] }), "hand-off", "on-hold"],
  ["instance hold label on the issue only", inputs({ issueLabels: ["lastlight-ignore"] }), "hand-off", "on-hold"],
  ["instance hold label in mixed case", inputs({ prLabels: ["LastLight-Ignore"] }), "hand-off", "on-hold"],
  ["a renamed instance hold label", inputs({ holdLabel: "frozen", issueLabels: ["Frozen"] }), "hand-off", "on-hold"],
  ["order: the instance hold beats a merge hold label", inputs({ prLabels: ["do-not-merge", "lastlight-ignore"] }), "hand-off", "on-hold"],
  ["protected-path", inputs({ changedPaths: ["src/a.ts", ".github/workflows/ci.yml"] }), "hand-off", "protected-path"],
  ["protected-path rename from", inputs({ changedPaths: ["ci.yml", ".github/workflows/ci.yml"] }), "hand-off", "protected-path"],
  ["protected nested CODEOWNERS", inputs({ changedPaths: ["docs/CODEOWNERS"] }), "hand-off", "protected-path"],
  // A build commits its own run notes under .lastlight/issue-<N>/; only that dir is exempt.
  ["own-dir notes merge", inputs({ changedPaths: ["src/x.js", ".lastlight/issue-12/architect-plan.md", ".lastlight/issue-12/status.md"] }), "merge", "clean"],
  ["another issue's dir is protected", inputs({ issueNumber: 13, changedPaths: ["src/x.js", ".lastlight/issue-12/status.md"] }), "hand-off", "protected-path"],
  ["lastlight.yml stays protected", inputs({ changedPaths: [".lastlight/lastlight.yml"] }), "hand-off", "protected-path"],
  ["agent-context stays protected", inputs({ changedPaths: [".lastlight/agent-context/x.md"] }), "hand-off", "protected-path"],
  ["rename of a protected file into the own dir", inputs({ changedPaths: [".lastlight/issue-12/x", ".lastlight/lastlight.yml"] }), "hand-off", "protected-path"],
  ["issue-N as a file (no slash)", inputs({ changedPaths: [".lastlight/issue-12"] }), "hand-off", "protected-path"],
  ["issue-N dir with nothing after the slash", inputs({ changedPaths: [".lastlight/issue-12/"] }), "hand-off", "protected-path"],
  ["issue-120 is not issue-12", inputs({ changedPaths: [".lastlight/issue-120/x"] }), "hand-off", "protected-path"],
  ["issue-12x is not issue-12", inputs({ changedPaths: [".lastlight/issue-12x/x"] }), "hand-off", "protected-path"],
  ["workflow file with own-dir notes", inputs({ changedPaths: [".github/workflows/test.yml", ".lastlight/issue-12/status.md"] }), "hand-off", "protected-path"],
  ["own-dir notes vs a repo-added .lastlight pattern", inputs({ changedPaths: [".lastlight/issue-12/status.md"] }), "merge", "clean", { ...cfg, protectedPaths: [...cfg.protectedPaths, ".lastlight/issue-*/**"] }],
  ["own-dir notes still unknown paths", inputs({ changedPaths: null }), "hand-off", "paths-unknown"],
  ["paths-unknown", inputs({ changedPaths: null }), "hand-off", "paths-unknown"],
  ["review-mismatch", inputs({ review: rev({ prNumber: 8 }) }), "hand-off", "review-mismatch"],
  ["changes-requested", inputs({ review: rev({ verdict: "REQUEST_CHANGES" }) }), "hand-off", "changes-requested"],
  ["conflict", inputs({ mergeableState: "dirty" }), "hand-off", "conflict"],
  ["no-review", inputs({ review: null }), "wait", "no-review"],
  // Nothing re-records a moved head, so a stale review needs a human (I4b).
  ["stale-review", inputs({ review: rev({ reviewedSha: "A" }) }), "hand-off", "stale-review"],
  ["stale request-changes", inputs({ review: rev({ reviewedSha: "A", verdict: "REQUEST_CHANGES" }) }), "hand-off", "stale-review"],
  ["stale-review beats pending checks", inputs({ review: rev({ reviewedSha: "A" }), state: { checksState: "pending" } }), "hand-off", "stale-review"],
  // Only an explicit APPROVED authorises a merge (I5).
  ["unknown verdict", inputs({ review: rev({ verdict: "COMMENTED" }) as never }), "hand-off", "not-approved"],
  ["checks-pending", inputs({ state: { checksState: "pending" } }), "wait", "checks-pending"],
  ["no-checks", inputs({ state: { checksState: "none", settledCheckCount: 0 } }), "wait", "no-checks"],
  ["too few checks", inputs({ state: { settledCheckCount: 0 } }), "wait", "no-checks"],
  ["checks-failing", inputs({ state: { checksState: "failing" } }), "wait", "checks-failing"],
  ["mergeable null", inputs({ mergeableState: null }), "wait", "mergeable-unknown"],
  ["mergeable unknown", inputs({ mergeableState: "unknown" }), "wait", "mergeable-unknown"],
  ["blocked", inputs({ mergeableState: "blocked" }), "wait", "blocked"],
  ["behind", inputs({ mergeableState: "behind" }), "wait", "behind"],
  ["unstable", inputs({ mergeableState: "unstable" }), "wait", "not-clean"],
  ["has_hooks", inputs({ mergeableState: "has_hooks" }), "wait", "not-clean"],
  ["clean", inputs(), "merge", "clean"],
  ["0 required checks, none", inputs({ state: { checksState: "none", settledCheckCount: 0 } }), "merge", "clean", { ...cfg, minSettledChecks: 0 }],
  ["0 required, failing still waits", inputs({ state: { checksState: "failing" } }), "wait", "checks-failing", { ...cfg, minSettledChecks: 0 }],
  ["order: disabled beats protected", inputs({ mergeEnabled: false, changedPaths: [".github/x"] }), "wait", "merge-disabled"],
  ["order: hand-off beats review wait", inputs({ review: null, prLabels: ["do-not-merge"] }), "hand-off", "hold-label"],
];

describe("mayMergeBuild", () => {
  it.each(rows)("%s", (_n, i, decision, kase, c) => {
    const r = mayMergeBuild(i, c ?? cfg);
    expect(r.decision).toBe(decision);
    expect(r.reason.startsWith(`${kase}: `)).toBe(true);
    expect(r.inputs).toBeTypeOf("object");
  });
});

describe("globToRegExp", () => {
  it.each([
    ["**/CODEOWNERS", "CODEOWNERS", true],
    ["**/CODEOWNERS", "docs/CODEOWNERS", true],
    ["**/CODEOWNERS", "docs/CODEOWNERSX", false],
    [".github/**", ".github/workflows/ci.yml", true],
    [".github/**", ".githubx/a", false],
    ["*.md", "a.md", true],
    ["*.md", "d/a.md", false],
    ["a.b", "aXb", false],
  ])("%s vs %s", (g, p, ok) => {
    expect(globToRegExp(g).test(p)).toBe(ok);
  });
});
