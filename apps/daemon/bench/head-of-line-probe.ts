/**
 * What head-of-line.ts reads from its bench daemon about the event loop: the longest gaps
 * between turns, and each synchronous deflate the relay channel ran (size and time). The
 * deflates are recorded by head-of-line-zlib.ts, which head-of-line-daemon.ts loads in place of
 * `node:zlib` for the relay channel only. Bench code; nothing in the product imports it.
 */
export interface Deflate {
  bytes: number;
  ms: number;
  at: number;
}

/**
 * A client command as it crossed the daemon's end of the relay channel (relay path only), on
 * the epoch clock: when it arrived, when its result was handed to the channel, and when the
 * channel had written that result to the relay.
 */
export interface RelayCommand {
  commandId: string;
  payload: string;
  threadId: string;
  inAt: number;
  sendAt?: number;
  sentAt?: number;
}
const relayCommands = new Map<string, RelayCommand>();
/**
 * Every line the daemon sent on the relay path, with when and a short account of what it held
 * (reconnect-bytes.ts), and when each hello arrived.
 */
export interface SentLine {
  at: number;
  type: string;
  bytes: number;
  subscriptionId?: string;
  /** events: payload type → [count, bytes]; and the threads its events were of. */
  payloads?: Record<string, [number, number]>;
  threads?: string[];
  /** threads.patch: how many threads it carried, removed, and their ids. */
  patched?: number;
  removed?: number;
  /** snapshot: its kind, and how many items or threads it held. */
  view?: { kind: string; items: number; threads: number };
}
const sentLines: SentLine[] = [];
const hellos: number[] = [];

function account(line: string, at: number): SentLine {
  const type = /^\{"type":"([^"]+)"/.exec(line)?.[1] ?? "?";
  const sent: SentLine = { at, type, bytes: line.length };
  if (type !== "events" && type !== "threads.patch" && type !== "snapshot") return sent;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return sent;
  }
  if (typeof value !== "object" || value === null) return sent;
  const message = value as Record<string, unknown>;
  if (typeof message.subscriptionId === "string") sent.subscriptionId = message.subscriptionId;
  if (type === "events" && Array.isArray(message.events)) {
    const payloads: Record<string, [number, number]> = {};
    const threads = new Set<string>();
    for (const event of message.events as Record<string, unknown>[]) {
      const payload = event.payload as Record<string, unknown> | undefined;
      const kind =
        typeof payload?.type === "string"
          ? payload.type
          : Array.isArray(event.d)
            ? "item.delta"
            : "?";
      const entry = (payloads[kind] ??= [0, 0]);
      entry[0]++;
      entry[1] += JSON.stringify(event).length;
      if (typeof event.threadId === "string") threads.add(event.threadId);
    }
    if (typeof message.threadId === "string") threads.add(message.threadId);
    sent.payloads = payloads;
    sent.threads = [...threads];
  }
  if (type === "threads.patch") {
    const threads = message.threads as Record<string, unknown> | undefined;
    sent.patched = threads ? Object.keys(threads).length : 0;
    sent.removed = Array.isArray(message.removed) ? message.removed.length : 0;
    sent.threads = threads ? Object.keys(threads) : [];
  }
  if (type === "snapshot") {
    const view = message.view as Record<string, unknown> | undefined;
    sent.view = {
      kind: typeof view?.kind === "string" ? view.kind : "?",
      items: view?.items && typeof view.items === "object" ? Object.keys(view.items).length : 0,
      threads:
        view?.threads && typeof view.threads === "object" ? Object.keys(view.threads).length : 0,
    };
  }
  return sent;
}

/** What the daemon sent on the relay path, by message type: count and bytes. */
const relaySent = new Map<string, { count: number; bytes: number }>();
const epochNow = () => performance.timeOrigin + performance.now();

/** The daemon's relay channel received `text` (`in`), or is sending it (`send`, then `sent`). */
export function recordRelay(kind: "in" | "send" | "sent", text: string): void {
  if (kind === "in") {
    if (text.startsWith('{"type":"hello"')) hellos.push(epochNow());
    if (!text.startsWith('{"type":"command"')) return;
    const commandId = /"command":\{"id":"([^"]+)"/.exec(text)?.[1];
    if (!commandId) return;
    relayCommands.set(commandId, {
      commandId,
      payload: /"payload":\{"type":"([^"]+)"/.exec(text)?.[1] ?? "",
      threadId: /"threadId":"([^"]+)"/.exec(text)?.[1] ?? "",
      inAt: epochNow(),
    });
    return;
  }
  for (const line of text.split("\n")) {
    if (kind === "send") {
      sentLines.push(account(line, epochNow()));
      const type = /^\{"type":"([^"]+)"/.exec(line)?.[1] ?? "?";
      const entry = relaySent.get(type) ?? { count: 0, bytes: 0 };
      entry.count++;
      entry.bytes += line.length;
      relaySent.set(type, entry);
    }
    if (!line.includes('"type":"commandResult"')) continue;
    const commandId = /"commandId":"([^"]+)"/.exec(line)?.[1];
    const known = commandId ? relayCommands.get(commandId) : undefined;
    if (!known) continue;
    if (kind === "send") known.sendAt ??= epochNow();
    else known.sentAt ??= epochNow();
  }
}

const deflates: Deflate[] = [];
const gaps: { at: number; ms: number }[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let last = 0;

export function recordDeflate(bytes: number, ms: number): void {
  deflates.push({ bytes, ms, at: performance.now() });
}

/** Start (or restart) watching: each turn of the event loop records how late it ran. */
export function resetProbe(): void {
  deflates.length = 0;
  relayCommands.clear();
  relaySent.clear();
  sentLines.length = 0;
  hellos.length = 0;
  gaps.length = 0;
  if (timer) clearTimeout(timer);
  last = performance.now();
  const tick = () => {
    const now = performance.now();
    // Gaps under 4 ms are the timer's own resolution: kept out so a long run stays small.
    if (now - last >= 4) gaps.push({ at: now, ms: now - last });
    last = now;
    timer = setTimeout(tick, 1);
  };
  timer = setTimeout(tick, 1);
}

/**
 * What happened since the reset: the longest gaps, and for each the deflate time inside it
 * (deflates that ended within the gap), plus every deflate's size.
 */
export function readProbe() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const longest = gaps.toSorted((a, b) => b.ms - a.ms).slice(0, 5);
  return {
    longestGaps: longest.map((gap) => ({
      ms: Math.round(gap.ms * 10) / 10,
      deflateMs:
        Math.round(
          deflates
            .filter((deflate) => deflate.at <= gap.at && deflate.at >= gap.at - gap.ms)
            .reduce((total, deflate) => total + deflate.ms, 0) * 10,
        ) / 10,
    })),
    deflates: deflates.map((deflate) => ({
      bytes: deflate.bytes,
      ms: Math.round(deflate.ms * 100) / 100,
    })),
    relayCommands: [...relayCommands.values()],
    relaySent: Object.fromEntries(relaySent),
    sentLines,
    hellos,
  };
}
