import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { api, type UsageView } from "../api";
import { dataAge, parseMaxPercent, resetsIn, usageRows, usageState } from "../lib/usage-view";

/**
 * The usage gate (`autonomy.budget.usage`): one bar per window with the
 * threshold marked, whether autonomous builds are being held and which issues
 * wait, and the runtime override of the threshold and the on/off switch.
 *
 * `compact` is the Board toolbar's one-line chip; it opens the full panel.
 */
export function UsagePanel({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<UsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.usage());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (compact) {
    if (!data || !data.configured) return null;
    const state = usageState(data, new Date());
    const top = usageRows(data).reduce((m, r) => Math.max(m, r.usedPct), 0);
    return (
      <div className="relative">
        <button
          className={clsx(
            "btn btn-xs btn-ghost gap-1 font-mono",
            state.kind === "holding" && "text-warning",
            state.kind === "unavailable" && "text-error",
          )}
          onClick={() => setOpen((o) => !o)}
          title="Usage gate"
        >
          usage {Math.round(top)}%
          {state.kind === "holding" && " · holding"}
          {state.kind === "unavailable" && " · no data"}
          {state.kind === "disabled" && " · off"}
        </button>
        {open && (
          <div className="fixed inset-x-4 top-24 z-30 sm:absolute sm:inset-x-auto sm:left-0 sm:top-auto sm:mt-1 sm:w-[22rem]">
            <UsageBody data={data} onChange={setData} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card bg-base-200 border border-hairline rounded-panel shadow-panel">
      <div className="card-body p-4">
        <h2 className="card-title text-sm font-semibold text-strong uppercase tracking-wide mb-2">Usage</h2>
        {error && !data ? (
          <div className="text-xs text-error">{error}</div>
        ) : !data ? (
          <span className="loading loading-spinner loading-sm text-faint" />
        ) : (
          <UsageBody data={data} onChange={setData} bare />
        )}
      </div>
    </div>
  );
}

function UsageBody({ data, onChange, bare = false }: { data: UsageView; onChange: (u: UsageView) => void; bare?: boolean }) {
  const now = new Date();
  const state = usageState(data, now);
  const rows = usageRows(data);
  const eff = data.settings.effective;
  const [draft, setDraft] = useState(String(eff.maxPercent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(String(eff.maxPercent)), [eff.maxPercent]);

  async function write(fn: () => Promise<UsageView>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const parsed = parseMaxPercent(draft);

  return (
    <div className={clsx("space-y-3 text-xs", !bare && "rounded-panel border border-hairline bg-base-200 p-3 shadow-panel")}>
      {state.kind === "not-configured" ? (
        <div className="text-muted">
          Usage gate not configured. Set <code className="font-mono">autonomy.budget.usage.source</code> to pace
          autonomous builds by your subscription's usage windows.
        </div>
      ) : (
        <>
          <div
            className={clsx(
              "rounded px-2 py-1",
              state.kind === "holding" && "bg-warning/10 text-warning",
              state.kind === "unavailable" && "bg-error/10 text-error",
              state.kind === "open" && "bg-success/10 text-success",
              state.kind === "disabled" && "bg-base-100 text-muted",
            )}
          >
            {state.kind === "holding" && (
              <>
                Holding autonomous builds{state.since ? ` since ${new Date(state.since).toLocaleTimeString()}` : ""}:{" "}
                {state.reason}
              </>
            )}
            {state.kind === "unavailable" && (
              <>
                {state.reason}
                {eff.onUnavailable === "hold" ? " — builds are held" : " — builds are not held"}
              </>
            )}
            {state.kind === "open" && <>Open: builds dispatch normally</>}
            {state.kind === "disabled" && <>Off: usage is not checked</>}
          </div>

          {rows.length > 0 && (
            <div className="space-y-2">
              {rows.map((r) => (
                <div key={r.key}>
                  <div className="flex flex-wrap justify-between gap-x-2 text-2xs text-muted mb-0.5">
                    <span className="font-mono text-strong">
                      {r.provider} · {r.window}
                    </span>
                    <span className="font-mono">
                      {Math.round(r.usedPct)}%
                      {r.resetsAt ? ` · ${resetsIn(r.resetsAt, now)}` : ""}
                    </span>
                  </div>
                  <div className="relative h-1.5 w-full rounded bg-base-300">
                    <div
                      className={clsx("h-full rounded", r.over ? "bg-warning" : "bg-primary")}
                      style={{ width: `${r.usedPct}%` }}
                    />
                    <div
                      className="absolute -top-0.5 h-2.5 w-px bg-base-content"
                      style={{ left: `${r.thresholdPct}%` }}
                      title={`threshold ${r.thresholdPct}%`}
                    />
                  </div>
                </div>
              ))}
              {data.snapshot && <div className="text-2xs text-faint">{dataAge(data.snapshot.updatedAt, now)}</div>}
            </div>
          )}

          {data.waiting.length > 0 && (
            <div>
              <div className="text-2xs text-muted mb-0.5">Waiting ({data.waiting.length})</div>
              <ul className="space-y-0.5">
                {data.waiting.map((w) => (
                  <li key={`${w.repo}#${w.issueNumber}`} className="font-mono text-2xs break-all">
                    <a
                      className="link link-hover"
                      href={`https://github.com/${w.repo}/issues/${w.issueNumber}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {w.repo}#{w.issueNumber}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-2">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                className="toggle toggle-xs toggle-primary"
                checked={eff.enabled}
                disabled={busy}
                onChange={(e) => void write(() => api.setUsageSettings({ enabled: e.target.checked }))}
              />
              <span>Gate on</span>
            </label>
            <label className="flex items-center gap-1">
              <span>Hold at</span>
              <input
                className="input input-xs input-bordered w-14 font-mono"
                inputMode="numeric"
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
              />
              <span>%</span>
            </label>
            <button
              className="btn btn-xs btn-primary"
              disabled={busy || parsed === null || parsed === eff.maxPercent}
              onClick={() => parsed !== null && void write(() => api.setUsageSettings({ maxPercent: parsed }))}
            >
              Save
            </button>
            {data.settings.override && (
              <button
                className="btn btn-xs btn-ghost"
                disabled={busy}
                onClick={() => void write(() => api.clearUsageOverride())}
              >
                Reset to config ({data.settings.config.maxPercent}%{data.settings.config.enabled ? "" : ", off"})
              </button>
            )}
          </div>
          {error && <div className="text-error">{error}</div>}
        </>
      )}
    </div>
  );
}
