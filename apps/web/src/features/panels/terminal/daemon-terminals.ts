import type { ClientApi } from "@ace/client";
import {
  ThreadId,
  type ServerMessage,
  type TerminalDescriptor,
  type TerminalRequest,
} from "@ace/protocol";
import type { TerminalEvent, TerminalInfo, TerminalSource } from "../sources.ts";

/** `terminal.request` `write` carries at most this many characters. */
const writeChunk = 8192;
/** Threads whose terminal lists are kept; a thread read again after that is listed again. */
const keptLists = 64;

type Output = Extract<ServerMessage, { type: "terminal.output" }>;

interface Stream {
  terminalId: string;
  listener: (event: TerminalEvent) => void;
}

const info = (descriptor: TerminalDescriptor): TerminalInfo => ({
  id: descriptor.id,
  threadId: descriptor.threadId,
  name: descriptor.name,
  exited: descriptor.exited,
});

/** The next free name: "Terminal", then "Terminal 2", "Terminal 3", ... */
export function terminalName(taken: readonly TerminalInfo[], base = "Terminal"): string {
  const names = new Set(taken.map((terminal) => terminal.name));
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
  return name;
}

/**
 * The daemon's PTYs (ADR 0057; the terminal service owns them). Output is credit-paced: the
 * daemon sends one `terminal.output` per credit, so a slow page never buffers unbounded output.
 * A `resync` (the ring dropped our offset) or `exit` ends a stream; a resync re-subscribes from
 * the oldest offset the daemon still has. Credit is granted while the page is hidden too: the
 * daemon's ring holds only the newest output, so pausing a hidden page would lose a long build's
 * log. Lists are read per thread and kept until a change, for the most recently read threads.
 */
export function daemonTerminals(client: ClientApi): TerminalSource {
  const listeners = new Set<() => void>();
  const lists = new Map<string, readonly TerminalInfo[]>();
  /** Threads whose list has been read since it was last forgotten. */
  const read = new Set<string>();
  const threadOf = new Map<string, string>();
  const streams = new Map<string, Stream>();
  let version = 0;
  let link: TerminalSource["link"] = client.state === "ready" ? "connected" : "disconnected";
  let subscriptions = 0;
  // Tabs behind one shared-worker connection each run a source; the daemon keys streams by id.
  const prefix = `terminal-${crypto.randomUUID().slice(0, 8)}`;
  const changed = () => {
    version++;
    for (const listener of listeners) listener();
  };
  const request = async (operation: TerminalRequest["operation"]) => {
    const reply = await client.request({ type: "terminal.request", operation });
    if (!reply.ok) throw new Error(reply.error ?? "terminal_failed");
    return reply;
  };
  const streaming = (terminalId: string) => {
    for (const stream of streams.values()) if (stream.terminalId === terminalId) return true;
    return false;
  };
  /** Forget a terminal's thread unless a stream still needs it (to subscribe after a resync). */
  const forget = (terminals: readonly TerminalInfo[], kept: readonly TerminalInfo[] = []) => {
    for (const terminal of terminals)
      if (!kept.some((other) => other.id === terminal.id) && !streaming(terminal.id))
        threadOf.delete(terminal.id);
  };
  /** Most recently read last; the oldest lists beyond `keptLists` are dropped. */
  const touch = (threadId: string, terminals: readonly TerminalInfo[]) => {
    lists.delete(threadId);
    lists.set(threadId, terminals);
    for (const [oldest, gone] of lists) {
      if (lists.size <= keptLists) break;
      lists.delete(oldest);
      read.delete(oldest);
      forget(gone);
    }
  };
  const remember = (threadId: string, terminals: readonly TerminalInfo[]) => {
    forget(lists.get(threadId) ?? [], terminals);
    for (const terminal of terminals) threadOf.set(terminal.id, threadId);
    touch(threadId, terminals);
    read.add(threadId);
    changed();
  };
  /** The shell ended: its tab stops showing it running without another list read. */
  const exited = (terminalId: string) => {
    const threadId = threadOf.get(terminalId);
    const terminals = threadId ? lists.get(threadId) : undefined;
    const at = terminals?.findIndex((terminal) => terminal.id === terminalId) ?? -1;
    const terminal = terminals?.[at];
    if (!threadId || !terminals || !terminal) return;
    const next = [...terminals];
    next[at] = { ...terminal, exited: true };
    remember(threadId, next);
  };
  const refresh = async (threadId: string) => {
    const reply = await request({ op: "list", threadId: ThreadId.parse(threadId) });
    remember(threadId, (reply.terminals ?? []).map(info));
  };
  const credit = (subscriptionId: string) => {
    try {
      client.send({ type: "terminal.credit", subscriptionId });
    } catch {
      // Offline: the stream ended with the connection and resumes from its offset on attach.
    }
  };
  const subscribe = (stream: Stream, fromOffset: number): string => {
    const subscriptionId = `${prefix}-${++subscriptions}`;
    const threadId = threadOf.get(stream.terminalId);
    streams.set(subscriptionId, stream);
    if (!threadId) return subscriptionId;
    request({
      op: "subscribe",
      threadId: ThreadId.parse(threadId),
      terminalId: stream.terminalId,
      subscriptionId,
      fromOffset,
    }).catch(() => streams.delete(subscriptionId));
    return subscriptionId;
  };
  // A stream re-subscribed after a resync keeps its detach working.
  const reattached = new WeakMap<Stream, string>();
  const receive = (message: Output) => {
    const stream = streams.get(message.subscriptionId);
    if (!stream) return;
    const event = message.event;
    if (event.type === "data") {
      stream.listener(event);
      credit(message.subscriptionId);
      return;
    }
    // Both end the daemon's stream.
    streams.delete(message.subscriptionId);
    if (event.type === "exit") {
      stream.listener({ type: "exit", code: event.status.code, nextOffset: event.nextOffset });
      exited(stream.terminalId);
      return;
    }
    stream.listener(event);
    const next = subscribe(stream, event.oldestOffset);
    reattached.set(stream, next);
  };
  try {
    client.onMessage((message) => {
      if (message.type === "terminal.output") receive(message);
    });
    client.connectionState().subscribe(() => {
      const next = client.state === "ready" ? "connected" : "disconnected";
      if (next === link) return;
      link = next;
      // The daemon ended every stream with the old connection; attach starts new ones.
      streams.clear();
      if (link === "connected")
        for (const threadId of lists.keys()) void refresh(threadId).catch(() => {});
      changed();
    });
  } catch {
    // A closed client: nothing will ever arrive.
  }
  return {
    get link() {
      return link;
    },
    get version() {
      return version;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list(threadId) {
      const known = lists.get(threadId);
      if (known) {
        touch(threadId, known);
        return known;
      }
      touch(threadId, []);
      if (link === "connected") void refresh(threadId).catch(() => {});
      return [];
    },
    listed: (threadId) => read.has(threadId),
    refresh,
    async open(threadId, cols, rows) {
      const reply = await request({
        op: "open",
        threadId: ThreadId.parse(threadId),
        name: terminalName(lists.get(threadId) ?? []),
        cols: Math.min(500, Math.max(1, cols)),
        rows: Math.min(500, Math.max(1, rows)),
      });
      if (!reply.terminal) throw new Error("terminal_failed");
      const opened = info(reply.terminal);
      remember(threadId, [
        ...(lists.get(threadId) ?? []).filter((t) => t.id !== opened.id),
        opened,
      ]);
      return opened;
    },
    attach(id, fromOffset, listener) {
      const stream: Stream = { terminalId: id, listener };
      const first = subscribe(stream, fromOffset);
      return () => {
        const current = reattached.get(stream) ?? first;
        if (!streams.delete(current) || link !== "connected") return;
        void request({ op: "unsubscribe", subscriptionId: current }).catch(() => {});
      };
    },
    write(id, data) {
      const threadId = threadOf.get(id);
      if (!threadId || link !== "connected") return;
      for (let at = 0; at < data.length; at += writeChunk)
        void request({
          op: "write",
          threadId: ThreadId.parse(threadId),
          terminalId: id,
          data: data.slice(at, at + writeChunk),
        }).catch(() => {});
    },
    resize(id, cols, rows) {
      const threadId = threadOf.get(id);
      if (!threadId || link !== "connected") return;
      void request({
        op: "resize",
        threadId: ThreadId.parse(threadId),
        terminalId: id,
        cols: Math.min(500, Math.max(1, cols)),
        rows: Math.min(500, Math.max(1, rows)),
      }).catch(() => {});
    },
    async close(id, known) {
      const threadId = known ?? threadOf.get(id);
      if (!threadId || link !== "connected") throw new Error("terminal_offline");
      await request({ op: "close", threadId: ThreadId.parse(threadId), terminalId: id });
      threadOf.delete(id);
      remember(
        threadId,
        (lists.get(threadId) ?? []).filter((terminal) => terminal.id !== id),
      );
    },
  };
}
