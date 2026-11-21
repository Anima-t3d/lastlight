/**
 * The names the router and the merge executor share, in a module with no
 * imports: `router.ts` names the `build-merge` handler without statically
 * loading `build-merge.ts`, which reaches the PR state machine and, through it,
 * the sandbox modules.
 */

/** What asked for an evaluation. Recorded on every ledger entry. */
export type MergeTrigger = "checks-settled" | "build-finished" | "sweep";

/** The in-process route handler the router names for a green build PR (`dispatcher.ts`). */
export const BUILD_MERGE_HANDLER = "build-merge";
