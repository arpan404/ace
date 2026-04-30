import { useMemo } from "react";

import {
  clearLoadDiagnostics,
  formatLoadDiagnosticsReport,
  logLoadDiagnostic,
  setLoadDiagnosticsEnabled,
  setLoadDiagnosticsExpanded,
  useLoadDiagnostics,
} from "../loadDiagnostics";
import { Button } from "./ui/button";

const LEVEL_ACCENT_CLASS: Record<string, string> = {
  info: "bg-sky-400/70",
  success: "bg-emerald-400/70",
  warning: "bg-amber-400/80",
  error: "bg-rose-400/80",
};

export function LoadDiagnosticsConsole() {
  const { enabled, expanded, entries } = useLoadDiagnostics();
  const latestEntry = entries.at(-1) ?? null;
  const visibleEntries = useMemo(() => entries.slice(-80).toReversed(), [entries]);

  if (!enabled) {
    return null;
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setLoadDiagnosticsExpanded(true)}
        className="fixed right-4 bottom-4 z-[70] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border border-white/10 bg-neutral-950/90 px-3 py-2 text-left text-white backdrop-blur-xl transition-transform hover:-translate-y-0.5"
      >
        <span
          className={`size-2.5 rounded-full ${
            LEVEL_ACCENT_CLASS[latestEntry?.level ?? "info"] ?? LEVEL_ACCENT_CLASS.info
          }`}
        />
        <span className="min-w-0">
          <span className="block text-[10px] font-semibold tracking-[0.24em] text-white/55 uppercase">
            Load console
          </span>
          <span className="block truncate font-mono text-[12px] text-white/92">
            {latestEntry
              ? `${latestEntry.phase} · ${latestEntry.message}`
              : "Waiting for boot events"}
          </span>
        </span>
      </button>
    );
  }

  return (
    <section className="fixed right-4 bottom-4 z-[70] flex max-h-[min(70vh,48rem)] w-[min(42rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-950/92 text-white backdrop-blur-2xl">
      <div className="border-b border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),transparent_58%)] px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold tracking-[0.28em] text-white/45 uppercase">
              App load flight recorder
            </p>
            <h2 className="mt-1 font-mono text-sm text-white/95">
              {latestEntry ? latestEntry.message : "Collecting startup diagnostics"}
            </h2>
            <p className="mt-1 text-xs text-white/55">{entries.length} events recorded</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                const report = formatLoadDiagnosticsReport();
                if (!navigator.clipboard) {
                  logLoadDiagnostic({
                    phase: "console",
                    level: "warning",
                    message: "Clipboard API unavailable for diagnostics copy",
                  });
                  return;
                }
                void navigator.clipboard.writeText(report).then(
                  () => {
                    logLoadDiagnostic({
                      phase: "console",
                      message: "Copied load diagnostics to clipboard",
                    });
                  },
                  (error) => {
                    logLoadDiagnostic({
                      phase: "console",
                      level: "warning",
                      message: "Failed to copy load diagnostics",
                      detail: error,
                    });
                  },
                );
              }}
            >
              Copy
            </Button>
            <Button size="xs" variant="outline" onClick={() => clearLoadDiagnostics()}>
              Clear
            </Button>
            <Button size="xs" variant="outline" onClick={() => setLoadDiagnosticsExpanded(false)}>
              Minimize
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setLoadDiagnosticsEnabled(false)}>
              Hide
            </Button>
          </div>
        </div>
      </div>

      <div className="overflow-auto px-3 py-3">
        <div className="space-y-2">
          {visibleEntries.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/12 px-4 py-6 text-center text-sm text-white/45">
              No diagnostic events yet.
            </div>
          ) : (
            visibleEntries.map((entry) => (
              <article
                key={entry.id}
                className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2.5 "
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1 size-2 rounded-full ${
                      LEVEL_ACCENT_CLASS[entry.level] ?? LEVEL_ACCENT_CLASS.info
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="rounded-full border border-white/8 bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.18em] text-white/45 uppercase">
                        {entry.phase}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-white/92">{entry.message}</p>
                    {entry.detail ? (
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/6 bg-black/20 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-white/58">
                        {entry.detail}
                      </pre>
                    ) : null}
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
