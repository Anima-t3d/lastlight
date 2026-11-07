/**
 * The usage gate's runtime half: effective settings (config ⊕ dashboard
 * override), the current verdict, and what a hold costs — one `autonomy.held`
 * webhook and one activity row per (provider, window, reset), never one per
 * sweep tick, plus the list of issues waiting on it for the dashboard.
 *
 * The verdict itself is the pure `evaluateUsage` in `./usage-gate.ts`.
 */
import { getAutonomyConfig } from "../config/config.js";
import { recordActivity } from "../activity.js";
import { buildRunPayload } from "../notify/webhook/payload.js";
import type { WebhookEmitter } from "../notify/webhook/emitter.js";
import type { StateDb, UsageGateOverride } from "../state/db.js";
import {
  evaluateUsage,
  readUsageSnapshot,
  type UsageGateConfig,
  type UsageReadResult,
  type UsageSettings,
  type UsageVerdict,
} from "./usage-gate.js";

interface UsageRuntime {
  emitter: Pick<WebhookEmitter, "emit"> | null;
  read: (source: UsageGateConfig["source"]) => Promise<UsageReadResult>;
  now: () => Date;
  botName: string;
  dashboardBase?: string;
}

const defaults = (): UsageRuntime => ({
  emitter: null,
  read: (source) => readUsageSnapshot(source),
  now: () => new Date(),
  botName: "last-light",
});

let runtime: UsageRuntime = defaults();
/** Hold keys already announced; cleared when the gate next reads not-held. */
const announced = new Set<string>();
/** `owner/repo#N` → the issue held and since when. */
const waiting = new Map<string, { repo: string; issueNumber: number; since: string }>();

/** Wired at boot (`index.ts`): the webhook emitter and the identity for payloads. */
export function configureUsageGate(patch: Partial<UsageRuntime>): void {
  runtime = { ...runtime, ...patch };
}

export function resetUsageGateForTests(): void {
  runtime = defaults();
  announced.clear();
  waiting.clear();
}

export interface UsageSettingsView {
  /** What the gate applies: config, with the override's non-null fields on top. */
  effective: UsageGateConfig;
  config: UsageGateConfig;
  override: UsageGateOverride | null;
}

export async function resolveUsageSettings(db: StateDb): Promise<UsageSettingsView> {
  // A config without the block (a partial stub, an older shape) is "gate off".
  const config: UsageGateConfig = getAutonomyConfig().budget.usage ?? {
    source: null,
    maxPercent: 80,
    windows: ["five_hour", "weekly"],
    staleAfterSeconds: 600,
    onUnavailable: "allow",
    enabled: true,
  };
  let override: UsageGateOverride | null = null;
  try {
    override = await db.getUsageOverride();
  } catch {
    // An unreadable override must not take the gate down; config applies.
  }
  const effective: UsageGateConfig = {
    ...config,
    windows: [...config.windows],
    ...(override?.enabled != null ? { enabled: override.enabled } : {}),
    ...(override?.maxPercent != null ? { maxPercent: override.maxPercent } : {}),
  };
  return { effective, config, override };
}

export interface UsageState {
  settings: UsageSettingsView;
  /** `null` when no source is configured: the gate is off. */
  read: UsageReadResult | null;
  verdict: UsageVerdict | null;
}

/** Read the source once and judge it. Never throws. */
export async function currentUsage(db: StateDb): Promise<UsageState> {
  const settings = await resolveUsageSettings(db);
  if (!settings.effective.source) return { settings, read: null, verdict: null };
  const read = await runtime.read(settings.effective.source).catch(
    (): UsageReadResult => ({ ok: false, reason: "usage source unreadable" }),
  );
  const { source: _source, ...judged } = settings.effective;
  const verdict = evaluateUsage(read, judged satisfies UsageSettings, runtime.now());
  return { settings, read, verdict };
}

/** The verdict for one dispatch; `undefined` when the gate is off. */
export async function usageVerdictForDispatch(db: StateDb): Promise<UsageVerdict | undefined> {
  const { verdict } = await currentUsage(db);
  // A not-held read ends the hold: the next one is announced afresh, and no
  // issue is waiting on it any more (the sweep will pick them up).
  if (verdict && !verdict.held) {
    announced.clear();
    waiting.clear();
  }
  return verdict ?? undefined;
}

function holdKey(verdict: Extract<UsageVerdict, { held: true }>): string {
  const w = verdict.window;
  return w ? `${w.provider}|${w.id}|${w.resetsAt ?? "unknown"}` : `unavailable|${verdict.reason.split(":")[0]}`;
}

/**
 * What a usage hold costs: the issue joins the waiting list; the first hold
 * on a given window and reset writes one activity row and sends one
 * `autonomy.held`. Later ticks on the same window add nothing. Never throws.
 */
export async function noteUsageHold(
  db: StateDb,
  subject: { repo: string; issueNumber: number; workflow: string },
  verdict: Extract<UsageVerdict, { held: true }>,
): Promise<void> {
  const triggerId = `${subject.repo}#${subject.issueNumber}`;
  if (!waiting.has(triggerId)) {
    waiting.set(triggerId, { repo: subject.repo, issueNumber: subject.issueNumber, since: runtime.now().toISOString() });
  }
  const key = holdKey(verdict);
  if (announced.has(key)) return;
  announced.add(key);

  await recordActivity(db, {
    action: "autonomy.skip",
    actorType: "system",
    targetType: "issue",
    targetId: triggerId,
    outcome: "denied",
    detail: {
      case: "usage-held",
      workflow: subject.workflow,
      reason: `usage-held: ${verdict.reason}`,
      maxPercent: verdict.maxPercent,
      // The activity detail is a flat map of non-null scalars.
      ...(verdict.window
        ? {
            provider: verdict.window.provider,
            window: verdict.window.id,
            usedPct: Math.round(verdict.window.usedPct),
            ...(verdict.window.resetsAt ? { resetsAt: verdict.window.resetsAt } : {}),
          }
        : {}),
    },
  });

  if (!runtime.emitter) return;
  try {
    const payload = buildRunPayload(
      "autonomy.held",
      undefined,
      {
        repo: subject.repo,
        issueNumber: subject.issueNumber,
        ...(verdict.window
          ? {
              hold: {
                provider: verdict.window.provider,
                window: verdict.window.id,
                usedPct: verdict.window.usedPct,
                maxPercent: verdict.maxPercent,
                resetsAt: verdict.window.resetsAt,
              },
            }
          : {}),
      },
      { botName: runtime.botName, dashboardBase: runtime.dashboardBase, now: runtime.now() },
    );
    runtime.emitter.emit(payload, subject.repo);
  } catch {
    // Best effort: the activity row is the record.
  }
}

/** The issue was dispatched (or is otherwise no longer held). */
export function clearUsageWaiting(repo: string, issueNumber: number): void {
  waiting.delete(`${repo}#${issueNumber}`);
}

/** Issues held by the usage gate since this process started, oldest first. */
export function listUsageWaiting(): Array<{ repo: string; issueNumber: number; since: string }> {
  return [...waiting.values()].sort((a, b) => a.since.localeCompare(b.since));
}
