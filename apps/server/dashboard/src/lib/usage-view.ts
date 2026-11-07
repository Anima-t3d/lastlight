import type { UsageView } from "../api";

/**
 * Pure readers for the Usage panel (`components/UsagePanel.tsx`), kept out of
 * the component so they are tested without a DOM.
 */

export type UsagePanelState =
  | { kind: "not-configured" }
  | { kind: "disabled" }
  | { kind: "unavailable"; reason: string }
  | { kind: "holding"; since: string | null; reason: string }
  | { kind: "open" };

/** "updated 14 min ago"; empty for an unparseable time. */
export function dataAge(updatedAt: string, now: Date): string {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((now.getTime() - t) / 60000);
  if (mins < 1) return "updated just now";
  if (mins < 120) return `updated ${mins} min ago`;
  return `updated ${Math.floor(mins / 60)} h ago`;
}

export function usageState(u: UsageView, now: Date): UsagePanelState {
  if (!u.configured) return { kind: "not-configured" };
  if (!u.settings.effective.enabled) return { kind: "disabled" };
  if (!u.snapshot) return { kind: "unavailable", reason: u.unavailableReason ?? "no usage data" };
  const verdictReason = u.verdict && "reason" in u.verdict ? (u.verdict.reason ?? "") : "";
  if (verdictReason.startsWith("usage data stale")) {
    return { kind: "unavailable", reason: `usage data stale, ${dataAge(u.snapshot.updatedAt, now)}` };
  }
  if (u.verdict?.held) {
    const since = u.waiting.length ? u.waiting.map((w) => w.since).sort()[0] : null;
    const w = u.verdict.window;
    // The bars already show when each window resets; the line stays short.
    const reason = w
      ? `${w.provider} ${w.id} at ${Math.round(Math.min(100, Math.max(0, w.usedPct)))}% (limit ${u.verdict.maxPercent}%)`
      : u.verdict.reason;
    return { kind: "holding", since, reason };
  }
  return { kind: "open" };
}

export interface UsageRow {
  key: string;
  provider: string;
  window: string;
  /** Clamped to 0–100. */
  usedPct: number;
  /** Where the threshold marker sits: the effective `maxPercent`. */
  thresholdPct: number;
  /** Never true for a window that has already reset (the gate skips it too). */
  over: boolean;
  /** The reset time has passed: the figure is from before it. */
  reset: boolean;
  resetsAt: string | null;
}

/** One row per window the gate counts, in snapshot order. */
export function usageRows(u: UsageView, now: Date): UsageRow[] {
  if (!u.snapshot) return [];
  const { maxPercent, windows } = u.settings.effective;
  return u.snapshot.windows
    .filter((w) => windows.includes(w.id))
    .map((w) => {
      const usedPct = Math.min(100, Math.max(0, w.usedPct));
      const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      const reset = !Number.isNaN(t) && t <= now.getTime();
      return {
        key: `${w.provider}/${w.id}`,
        provider: w.provider,
        window: w.id,
        usedPct,
        thresholdPct: maxPercent,
        over: !reset && usedPct >= maxPercent,
        reset,
        resetsAt: w.resetsAt,
      };
    });
}

/** The Board chip's figure: the fullest window that has not reset. */
export function topUsedPct(u: UsageView, now: Date): number {
  return usageRows(u, now)
    .filter((r) => !r.reset)
    .reduce((m, r) => Math.max(m, r.usedPct), 0);
}

/** The threshold field: an integer from 1 to 100, else null. */
export function parseMaxPercent(input: string): number | null {
  const t = input.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 100 ? n : null;
}

/** "resets in 3 h 5 min"; "reset" once past; empty when unknown. */
export function resetsIn(resetsAt: string | null, now: Date): string {
  if (!resetsAt) return "";
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((t - now.getTime()) / 60000);
  if (mins <= 0) return "reset";
  if (mins < 60) return `resets in ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `resets in ${h} h${mins % 60 ? ` ${mins % 60} min` : ""}`;
  const d = Math.floor(h / 24);
  return `resets in ${d} d${h % 24 ? ` ${h % 24} h` : ""}`;
}

export interface RecentHoldRow {
  key: string;
  at: string;
  issue: string;
  what: string;
}

/**
 * The last `autonomy.held` records (activity `autonomy.skip`, case
 * `usage-held`), newest first: the trace that builds were held once the hold
 * is over and the waiting list is empty.
 */
export function recentHoldRows(u: UsageView, limit = 5): RecentHoldRow[] {
  return [...u.recentHolds]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map((h) => {
      const d = h.detail ?? {};
      const what =
        typeof d.provider === "string" && typeof d.window === "string"
          ? `${d.provider} ${d.window}${typeof d.usedPct === "number" ? ` at ${Math.round(d.usedPct)}%` : ""}`
          : "usage data unavailable";
      return { key: h.id, at: h.createdAt, issue: h.targetId ?? "", what };
    });
}
