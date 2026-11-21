/**
 * The name the router and the dispatcher share for the unblock route, in a
 * module with no imports (same reason as `build-merge-route.ts`): `router.ts`
 * names the handler without loading `promotion.ts` and the GitHub client.
 */

/** The in-process route handler for a closed issue that may unblock others (`dispatcher.ts`). */
export const PROMOTE_DEPENDENTS_HANDLER = "promote-dependents";
