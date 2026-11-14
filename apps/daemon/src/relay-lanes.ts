import { BULK, INTERACTIVE, type Lane } from "@ace/secure-channel";

/*
 * Which lane a server message takes on a relayed main channel whose client announced lanes
 * (ADR 0110), so an approval or a stream of output need not wait behind another thread's
 * snapshot.
 *
 * Bulk: the large pieces of state a client asked for (snapshots and their parts, pages,
 * windows, search and history results). A message may go ahead of queued bulk only when it
 * can't make anything look further along than the data it passes:
 *
 * - `pong`, which carries no state;
 * - an `events` batch whose every event only adds output or asks a human (`item.delta`,
 *   `item.created`, `interaction.opened`), when no queued bulk message is about one of its
 *   threads or its subscription. A thread's own snapshot is about that thread only if the
 *   client subscribed to it by thread (`observe`); any other snapshot, and every page, is
 *   about all threads.
 *
 * Everything else waits behind all queued bulk, and holds back everything after it: statuses
 * (agent and run state, settles, sidebar patches), command receipts, item updates, closes and
 * anything the router can't read. So nothing that says a thread moved on (done, settled,
 * accepted) ever reaches the client before data sent ahead of it, on any subscription; an
 * overtaking batch only adds work or output, which no later state contradicts. The channel's
 * queue adds the other half: a bulk message never passes an interactive one sent before it.
 * Pure; the socket says when a bulk message has gone out in full.
 */

const bulkTypes = new Set([
  "snapshot",
  "snapshot.part",
  "entities.page",
  "entities.page.part",
  "items.page",
  "items.window",
  "turns.page",
  "turn.steps",
  "thread.catchUp",
  "thread.search",
  "search.results",
  "history.list",
]);
/** Event payloads that only add output or ask a human: nothing reads them as progress. */
const additive = new Set(["item.delta", "item.created", "interaction.opened"]);
/** Every thread and subscription: what a message the router can't scope is about. */
const ALL = "*";
/** Larger batches are not parsed; they wait as if about everything. */
const PARSE_LIMIT = 64 * 1024;

const TYPE_PREFIX = /^\{"type":"([^"\\]{1,64})"/;
const SUBSCRIPTION_KEY = /^,"subscriptionId":"([^"\\]{1,256})"/;

export interface Routed {
  lane: Lane;
  /** Call once the message has gone out in full (or the channel ended). */
  sent(): void;
}

const nothing = () => {};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

/** What an additive batch is about (its subscription and threads), else undefined. */
function additiveScope(line: string): string[] | undefined {
  if (line.length > PARSE_LIMIT) return undefined;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (parsed?.type !== "events" || typeof parsed.subscriptionId !== "string") return undefined;
  const events = parsed.events;
  if (!Array.isArray(events)) return undefined;
  const scope = [`sub:${parsed.subscriptionId}`];
  for (const value of events) {
    const event = record(value);
    const payload = record(event?.payload);
    if (typeof event?.threadId !== "string" || typeof payload?.type !== "string") return undefined;
    if (!additive.has(payload.type)) return undefined;
    scope.push(`thread:${event.threadId}`);
  }
  return scope;
}

export class LaneRouter {
  /** Subscriptions the client opened on one thread, by id. */
  readonly #threadOf = new Map<string, string>();
  /** What queued bulk messages are about, counted. */
  readonly #held = new Map<string, number>();

  /** A message from the client: learns which subscriptions are on one thread. */
  observe(text: string): void {
    if (!text.startsWith('{"type":"subscribe"') && !text.startsWith('{"type":"unsubscribe"'))
      return;
    let message: Record<string, unknown> | undefined;
    try {
      message = record(JSON.parse(text));
    } catch {
      return;
    }
    const id = message?.subscriptionId;
    if (typeof id !== "string") return;
    const scope = record(message?.scope);
    if (
      message?.type === "subscribe" &&
      scope?.kind === "thread" &&
      typeof scope.threadId === "string"
    )
      this.#threadOf.set(id, scope.threadId);
    else this.#threadOf.delete(id);
  }

  /** The lane for bytes the router can't read (a binary message). */
  routeOpaque(): Routed {
    return this.#held.size === 0 ? { lane: INTERACTIVE, sent: nothing } : this.#hold([ALL]);
  }

  /** The lane for one frame's text: one message, or several on their own lines. */
  route(text: string): Routed {
    const lines = text.includes("\n") ? text.split("\n") : [text];
    const types = lines.map((line) => TYPE_PREFIX.exec(line)?.[1]);
    const bulk = lines.flatMap((line, index) => {
      const type = types[index];
      return type !== undefined && bulkTypes.has(type) ? [this.#bulkScope(type, line)] : [];
    });
    if (bulk.length > 0) return this.#hold(bulk.flat());
    // Nothing queued in bulk: nothing to go ahead of.
    if (this.#held.size === 0) return { lane: INTERACTIVE, sent: nothing };
    if (types.every((type) => type === "pong")) return { lane: INTERACTIVE, sent: nothing };
    const scopes = lines.map((line, index) =>
      types[index] === "pong" ? [] : (additiveScope(line) ?? [ALL]),
    );
    const scope = scopes.flat();
    if (this.#held.has(ALL) || scope.some((key) => key === ALL || this.#held.has(key)))
      return this.#hold(scope);
    return { lane: INTERACTIVE, sent: nothing };
  }

  /** A thread subscription's snapshot is about its thread; any other bulk, about all. */
  #bulkScope(type: string, line: string): string[] {
    if (type !== "snapshot" && type !== "snapshot.part") return [ALL];
    const subscription = SUBSCRIPTION_KEY.exec(line.slice(`{"type":"${type}"`.length))?.[1];
    const thread = subscription === undefined ? undefined : this.#threadOf.get(subscription);
    return subscription === undefined || thread === undefined
      ? [ALL]
      : [`sub:${subscription}`, `thread:${thread}`];
  }

  #hold(keys: string[]): Routed {
    const held = new Set(keys.length > 0 ? keys : [ALL]);
    for (const key of held) this.#held.set(key, (this.#held.get(key) ?? 0) + 1);
    let done = false;
    return {
      lane: BULK,
      sent: () => {
        if (done) return;
        done = true;
        for (const key of held) {
          const count = (this.#held.get(key) ?? 0) - 1;
          if (count > 0) this.#held.set(key, count);
          else this.#held.delete(key);
        }
      },
    };
  }
}
