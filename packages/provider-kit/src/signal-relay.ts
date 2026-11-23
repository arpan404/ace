// BroadcastChannel.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { BroadcastChannel, isMainThread, threadId } from "node:worker_threads";
import type { TreeMember } from "./process-tree.ts";

/*
 * Signal rules live in the isolate that installed them (the daemon's main thread), but processes
 * are also started and stopped from worker isolates (probes, review). A worker without rules of
 * its own hands each signal to the guarded isolate instead, with the evidence it holds: the
 * leader's identity while the leader pinned its group, and the members recorded for it. The
 * guarded isolate re-checks the leader there and applies its rules to every signal.
 *
 * A host that installed no rules anywhere (the desktop app, a CLI) answers nothing; a worker
 * then signals locally, as it would without the relay.
 */

const channelName = "ace.owned-signals";

/** One signal for a leader's group, with what proves which processes are the group's. */
export type RelayedSignal = {
  /** Set while the leader was seen unreaped: its group may be signalled by number if it still is. */
  leader?: TreeMember;
  /** Members recorded while the leader lived, or linked to it by recorded lineage. */
  members: TreeMember[];
  signal: NodeJS.Signals;
};
type Message =
  | { type: "signal"; id: string; request: RelayedSignal }
  | { type: "taken"; id: string }
  | { type: "guarded"; guarded: boolean }
  | { type: "ask" };

/** How long a worker waits for the guarded isolate to take a signal before sending it itself. */
const takeMs = 250;

type Channel = { post(message: Message): void; close(): void };
/** A channel to every other isolate; it never keeps the process alive. */
function open(heard: (message: Message) => void): Channel {
  const channel = new BroadcastChannel(channelName);
  channel.unref();
  channel.addEventListener("message", (event) => {
    // Messages between ace's own isolates: trusted, not parsed again (ADR 0125).
    const data: Message = Reflect.get(event, "data");
    heard(data);
  });
  return { post: (message) => channel.postMessage(message), close: () => channel.close() };
}

let serving: { channel: Channel } | undefined;
/** Serve other isolates' signals here, under this isolate's rules. Returns the stop. */
export function serveRelayedSignals(handle: (request: RelayedSignal) => void): () => void {
  serving?.channel.close();
  const channel = open((data) => {
    if (data.type === "ask") channel.post({ type: "guarded", guarded: true });
    if (data.type !== "signal") return;
    channel.post({ type: "taken", id: data.id });
    try {
      handle(data.request);
    } catch (error) {
      process.emitWarning(`A relayed process signal failed: ${String(error)}`);
    }
  });
  const entry = { channel };
  serving = entry;
  channel.post({ type: "guarded", guarded: true });
  return () => {
    if (serving !== entry) return;
    serving = undefined;
    channel.post({ type: "guarded", guarded: false });
    channel.close();
  };
}

type Client = { channel: Channel; guarded: boolean | undefined; waiting: Map<string, () => void> };
let client: Client | undefined;
let sent = 0;
function relayClient() {
  if (client) return client;
  const waiting = new Map<string, () => void>();
  const state: Client = {
    channel: open((data) => {
      if (data.type === "guarded") state.guarded = data.guarded;
      if (data.type === "taken") {
        state.guarded = true;
        waiting.get(data.id)?.();
      }
    }),
    guarded: undefined,
    waiting,
  };
  state.channel.post({ type: "ask" });
  client = state;
  return state;
}

/**
 * Whether this isolate hands its signals on: a worker with no rules of its own, while some
 * isolate may serve them.
 */
export function relaysSignals(locallyGuarded: boolean): boolean {
  if (isMainThread || locallyGuarded) return false;
  return relayClient().guarded !== false;
}

/**
 * Hand a signal to the guarded isolate. `local` runs instead when none takes it in time, so a
 * host with no rules anywhere still stops its processes.
 */
export function relaySignal(request: RelayedSignal, local: () => void): void {
  const state = relayClient();
  const id = `${threadId}:${++sent}`;
  const timer = setTimeout(() => {
    state.waiting.delete(id);
    state.guarded = false;
    local();
  }, takeMs);
  timer.unref?.();
  state.waiting.set(id, () => {
    clearTimeout(timer);
    state.waiting.delete(id);
  });
  state.channel.post({ type: "signal", id, request });
}
