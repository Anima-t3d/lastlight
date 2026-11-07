/**
 * Usage windows as a dispatch input (`autonomy.budget.usage`).
 *
 * A subscription's real limits are rolling windows (a 5-hour window, a weekly
 * one) with a percentage used and a reset time. An operator points the gate at
 * a source that reports them, in a small provider-neutral contract:
 *
 *   { "updatedAt": ISO, "windows": [ { "provider", "id", "usedPct", "resetsAt": ISO | null } ] }
 *
 * and autonomous builds are held while any listed window is at or above
 * `maxPercent`. Reading the source and judging it are separate so the verdict
 * is a pure function, table-tested like the rest of the build gate.
 */
import { execFile } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";

export type UsageSource = { file: string } | { command: string[] };

export interface UsageGateConfig {
  /** `null` = no source configured: the gate is off. */
  source: UsageSource | null;
  /** Hold while any listed window is at or above this percentage (1–100). */
  maxPercent: number;
  /** Window ids that count (`five_hour`, `weekly`); others are ignored. */
  windows: string[];
  /** Data older than this is unavailable. */
  staleAfterSeconds: number;
  /** What unavailable data means: let builds through, or hold them. */
  onUnavailable: "allow" | "hold";
  /** Off switch that keeps the source configured (the dashboard override flips it). */
  enabled: boolean;
}

export type UsageSettings = Omit<UsageGateConfig, "source">;

export interface UsageWindow {
  provider: string;
  id: string;
  usedPct: number;
  resetsAt: string | null;
}

export interface UsageSnapshot {
  updatedAt: string;
  windows: UsageWindow[];
}

export type UsageReadResult = { ok: true; snapshot: UsageSnapshot } | { ok: false; reason: string };

export type UsageVerdict =
  | { held: false; reason?: string }
  | { held: true; window?: UsageWindow; maxPercent: number; reason: string };

/** A usage file is a few hundred bytes; anything this big is not one. */
const MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

type Exec = (argv: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

const defaultExec: Exec = (argv, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: timeoutMs, maxBuffer: MAX_BYTES, shell: false, windowsHide: true },
      (err, stdout) => {
        if (err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code !== "number") {
          reject(err);
          return;
        }
        const code = err ? Number((err as { code?: unknown }).code) : 0;
        resolve({ code, stdout: String(stdout) });
      },
    );
  });

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

function parseWindow(v: unknown): UsageWindow | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.provider !== "string" || !o.provider) return null;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.usedPct !== "number" || !Number.isFinite(o.usedPct)) return null;
  if (o.resetsAt !== null && o.resetsAt !== undefined && !isIsoDate(o.resetsAt)) return null;
  return { provider: o.provider, id: o.id, usedPct: o.usedPct, resetsAt: (o.resetsAt as string | null | undefined) ?? null };
}

/** Parse the contract. A bad envelope is unavailable; a bad window is dropped. */
export function parseUsageSnapshot(text: string): UsageReadResult {
  if (text.length > MAX_BYTES) return { ok: false, reason: "usage data larger than 64 KiB" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "usage data is not JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "usage data is not an object" };
  }
  const o = raw as Record<string, unknown>;
  if (!isIsoDate(o.updatedAt)) return { ok: false, reason: "usage data has no valid updatedAt" };
  if (!Array.isArray(o.windows)) return { ok: false, reason: "usage data has no windows list" };
  const windows = o.windows.map(parseWindow).filter((w): w is UsageWindow => w !== null);
  return { ok: true, snapshot: { updatedAt: o.updatedAt, windows } };
}

/**
 * Read the configured source. A file is read as text; a command runs as argv
 * (no shell) with a timeout, and its stdout is the contract. Never throws.
 */
export async function readUsageSnapshot(
  source: UsageSource | null,
  opts: { readFile?: (path: string) => Promise<string>; exec?: Exec; timeoutMs?: number } = {},
): Promise<UsageReadResult> {
  if (!source) return { ok: false, reason: "no usage source configured" };
  try {
    if ("file" in source) {
      const read = opts.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
      return parseUsageSnapshot(await read(source.file));
    }
    const exec = opts.exec ?? defaultExec;
    const { code, stdout } = await exec(source.command, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (code !== 0) return { ok: false, reason: `usage command exited ${code}` };
    return parseUsageSnapshot(stdout);
  } catch (err: unknown) {
    const code = (err as { code?: unknown })?.code;
    return { ok: false, reason: `usage source unreadable${typeof code === "string" ? ` (${code})` : ""}` };
  }
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/**
 * Judge a read against the settings. Held when any listed window that has not
 * reset yet is at or above `maxPercent` (the fullest one is named). Stale or
 * failed reads are unavailable, and `onUnavailable` decides. Disabled never holds.
 */
export function evaluateUsage(result: UsageReadResult, settings: UsageSettings, now: Date): UsageVerdict {
  if (!settings.enabled) return { held: false, reason: "usage gate disabled" };

  const unavailable = (reason: string): UsageVerdict =>
    settings.onUnavailable === "hold"
      ? { held: true, maxPercent: settings.maxPercent, reason }
      : { held: false, reason };

  if (!result.ok) return unavailable(`usage data unavailable: ${result.reason}`);
  const ageMs = now.getTime() - Date.parse(result.snapshot.updatedAt);
  if (ageMs > settings.staleAfterSeconds * 1000) {
    return unavailable(
      `usage data stale: updated ${Math.round(ageMs / 60000)} min ago (limit ${Math.round(settings.staleAfterSeconds / 60)} min)`,
    );
  }

  let worst: UsageWindow | undefined;
  for (const raw of result.snapshot.windows) {
    if (!settings.windows.includes(raw.id)) continue;
    if (raw.resetsAt && Date.parse(raw.resetsAt) <= now.getTime()) continue; // already reset
    const w = { ...raw, usedPct: clampPct(raw.usedPct) };
    if (w.usedPct >= settings.maxPercent && (!worst || w.usedPct > worst.usedPct)) worst = w;
  }
  if (!worst) return { held: false };
  return {
    held: true,
    window: worst,
    maxPercent: settings.maxPercent,
    reason: `${worst.provider} ${worst.id} at ${Math.round(worst.usedPct)}% ≥ ${settings.maxPercent}%, resets ${worst.resetsAt ?? "at an unknown time"}`,
  };
}
