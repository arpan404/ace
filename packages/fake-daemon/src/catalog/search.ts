import type { ProviderKind } from "@ace/protocol";

export type FakeSearchKind = "thread" | "message" | "tool_call" | "artifact";
export interface FakeSearchHit {
  itemId?: string;
  threadId: string;
  threadTitle: string;
  workspaceId: string;
  provider: ProviderKind;
  kind: FakeSearchKind;
  createdAt: number;
  snippet: { text: string; highlights: { start: number; end: number }[] };
}

interface Entry {
  itemId: string;
  threadId: string;
  threadTitle: string;
  workspaceId: string;
  provider: ProviderKind;
  kind: FakeSearchKind;
  ageMinutes: number;
  text: string;
}

const rows: readonly [string, string, string, ProviderKind, FakeSearchKind, number, string][] = [
  [
    "thread-retry-budget",
    "Retry budget for app-server restarts",
    "relay",
    "claude",
    "message",
    18,
    "The relay restarts app-server forever when it crashes on boot. Give it a retry budget.",
  ],
  [
    "thread-retry-budget",
    "Retry budget for app-server restarts",
    "relay",
    "claude",
    "message",
    17,
    "Restarts now back off from 250 ms to 30 s and stop after 6 attempts in 5 minutes. I squashed the fixups; the branch needs a force push.",
  ],
  [
    "thread-retry-budget",
    "Retry budget for app-server restarts",
    "relay",
    "claude",
    "tool_call",
    16,
    "git push --force-with-lease origin relay/retry-budget",
  ],
  [
    "thread-dedupe",
    "Dedupe thread events after reconnect",
    "ace",
    "claude",
    "message",
    5,
    "After a reconnect the client applies replayed events twice. Dedupe by sequence number.",
  ],
  [
    "thread-dedupe",
    "Dedupe thread events after reconnect",
    "ace",
    "claude",
    "tool_call",
    4,
    "bunx vitest run packages/client/src/subscriptions.test.ts",
  ],
  [
    "thread-refund-tax",
    "Partial refunds double-count tax",
    "billing-api",
    "claude",
    "message",
    40,
    "A partial refund returns the full tax line, so the ledger double-counts tax on the refund.",
  ],
  [
    "thread-install-page",
    "Rewrite the install page for the daemon",
    "docs-site",
    "opencode",
    "artifact",
    75,
    "docs/install.md: Run ace start and open the printed link. The daemon drives the CLIs you already use.",
  ],
  [
    "thread-pdf-locale",
    "Invoice PDF locale fallback",
    "billing-api",
    "codex",
    "message",
    120,
    "Invoices for de-AT fall back to en-US instead of de. Fall back along the locale chain.",
  ],
  [
    "thread-fan-out",
    "Backpressure on broadcast fan-out",
    "relay",
    "claude",
    "message",
    30,
    "Slow phones stall the broadcast fan-out. Add per-socket backpressure with a bounded buffer.",
  ],
  [
    "thread-replay-cursor",
    "Replay cursor resets on every resume",
    "relay",
    "claude",
    "message",
    130,
    "After a daemon restart the web client replays the last 40 or so events twice.",
  ],
  [
    "thread-replay-cursor",
    "Replay cursor resets on every resume",
    "relay",
    "claude",
    "tool_call",
    131,
    "bun run test apps/server --filter replay",
  ],
  [
    "thread-cold-start",
    "Cap cold-start replay at 200 events",
    "ace",
    "claude",
    "message",
    140,
    "Replay now treats seq 0 as a cold start and replays at most the last 200 events.",
  ],
  [
    "thread-cold-start",
    "Cap cold-start replay at 200 events",
    "ace",
    "claude",
    "artifact",
    141,
    "apps/server/src/replay.ts: a bounded cold-start replay window, COLD_START_WINDOW = 200",
  ],
  [
    "thread-dedupe",
    "Dedupe thread events after reconnect",
    "ace",
    "claude",
    "message",
    150,
    "The replay cursor resets on every resume, so the daemon resends everything after the last checkpoint.",
  ],
  [
    "thread-bump-codex",
    "Bump Codex app-server to 0.48",
    "ace",
    "codex",
    "thread",
    41,
    "Bump Codex app-server to 0.48",
  ],
];
const corpus: readonly Entry[] = rows.map(
  ([threadId, threadTitle, workspaceId, provider, kind, ageMinutes, text], index) => ({
    itemId: `search-item-${index}`,
    threadId,
    threadTitle,
    workspaceId,
    provider,
    kind,
    ageMinutes,
    text,
  }),
);

const context = 60;

/**
 * Token search: every whitespace-separated term must appear (case-insensitive). The snippet is
 * a window around the first match with every term occurrence highlighted, in UTF-16 offsets.
 */
export function searchThreads(
  text: string,
  now: number,
  filters: { kind?: FakeSearchKind | undefined } = {},
): FakeSearchHit[] {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: FakeSearchHit[] = [];
  for (const entry of corpus) {
    if (filters.kind && entry.kind !== filters.kind) continue;
    const lower = entry.text.toLowerCase();
    if (!terms.every((term) => lower.includes(term))) continue;
    const first = Math.min(...terms.map((term) => lower.indexOf(term)));
    const start = Math.max(0, first - context);
    const end = Math.min(entry.text.length, first + context * 2);
    const prefix = start > 0 ? "…" : "";
    const window = entry.text.slice(start, end);
    const highlights: { start: number; end: number }[] = [];
    const windowLower = window.toLowerCase();
    for (const term of terms) {
      for (let at = windowLower.indexOf(term); at >= 0; at = windowLower.indexOf(term, at + 1))
        highlights.push({ start: prefix.length + at, end: prefix.length + at + term.length });
    }

    hits.push({
      ...(entry.kind === "thread" ? {} : { itemId: entry.itemId }),
      threadId: entry.threadId,
      threadTitle: entry.threadTitle,
      workspaceId: entry.workspaceId,
      provider: entry.provider,
      kind: entry.kind,
      createdAt: now - entry.ageMinutes * 60_000,
      snippet: {
        text: prefix + window + (end < entry.text.length ? "…" : ""),
        highlights: merge(highlights.toSorted((a, b) => a.start - b.start)),
      },
    });
  }
  return hits.toSorted((a, b) => b.createdAt - a.createdAt);
}

/** Overlapping highlights (terms inside terms) merge into one range. */
function merge(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = out.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}
