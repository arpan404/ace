// BroadcastChannel.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { BroadcastChannel, isMainThread, threadId } from "node:worker_threads";
import { systemListing } from "./process-listing.ts";
import { deliverGroupSignal, type GroupSignal } from "./group-delivery.ts";
import { locallyGuarded } from "./process-owner.ts";
import { systemTreeIo } from "./process-tree.ts";

/*
 * Signal rules live in the isolate that installed them (the daemon's main thread), but processes
 * are also started and stopped from worker isolates (probes, review, Git). A worker hands each
 * signal to the main isolate with the evidence it holds; the main isolate delivers it under its
 * rules and answers after delivery with the outcome ("done", with the error if delivery failed),
 * or says it has no rules ("unguarded": a host without daemon rules by design, the desktop app or
 * a CLI), and only then does the worker deliver it itself. A worker that hears nothing after a
 * few tries fails the signal: it never signals without the rules it cannot see.
 */

const channelName = "ace.owned-signals";
type Message =
  | { type: "signal"; id: string; request: GroupSignal }
  | { type: "done"; id: string; error?: string }
  | { type: "unguarded"; id: string };
type Answer = Exclude<Message, { type: "signal" }>;

/** Each try's wait for the main isolate's answer, and how many tries before failing. */
const answerMs = 250;
const tries = 4;

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

let serving: Channel | undefined;
/**
 * Answer workers' signals from this, the main isolate. Called before any worker that can spawn
 * starts (`startWorker`); idempotent.
 */
export function serveWorkerSignals(): void {
  if (!isMainThread || serving) return;
  const channel = open((data) => {
    if (data.type !== "signal") return;
    if (!locallyGuarded()) {
      channel.post({ type: "unguarded", id: data.id });
      return;
    }
    try {
      deliverGroupSignal(data.request, { tree: systemTreeIo, listing: systemListing });
      channel.post({ type: "done", id: data.id });
    } catch (error) {
      channel.post({ type: "done", id: data.id, error: String(error) });
    }
  });
  serving = channel;
}

/** Whether this isolate hands its signals to the main isolate: any worker. */
export function relaysSignals(): boolean {
  return !isMainThread;
}

let client: { channel: Channel; waiting: Map<string, (answer: Answer) => void> } | undefined;
let sent = 0;
function relayClient() {
  if (client) return client;
  const waiting = new Map<string, (answer: Answer) => void>();
  const channel = open((data) => {
    if (data.type !== "signal") waiting.get(data.id)?.(data);
  });
  client = { channel, waiting };
  return client;
}

/**
 * Hand a signal to the main isolate. Resolves once it was delivered there, or here when the
 * main isolate has no rules by design; rejects when delivery failed or no answer came.
 */
export async function relaySignal(request: GroupSignal, local: () => void): Promise<void> {
  const state = relayClient();
  for (let attempt = 0; attempt < tries; attempt++) {
    const id = `${threadId}:${++sent}`;
    const answer = await new Promise<Answer | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), answerMs);
      timer.unref?.();
      state.waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      state.channel.post({ type: "signal", id, request });
    });
    state.waiting.delete(id);
    if (answer?.type === "done") {
      if (answer.error !== undefined)
        throw new Error(
          `Process group ${request.leader.pid} could not be signalled: ${answer.error}`,
        );
      return;
    }
    if (answer?.type === "unguarded") {
      local();
      return;
    }
  }
  throw new Error(
    `Process group ${request.leader.pid} was not signalled: no isolate with the signal rules answered`,
  );
}
