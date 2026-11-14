import { BULK, INTERACTIVE, type Lane } from "@ace/secure-channel";

/*
 * Which lane a server message takes on a relayed main channel whose client announced lanes
 * (ADR 0110), so an approval, a question or a delta need not wait behind a snapshot.
 *
 * Bulk: the large pieces of state a client asked for (snapshots and their parts, pages,
 * windows, search and history results). Everything else is interactive, unless it must stay
 * behind something already in the bulk lane:
 *
 * - a message about a subscription or request a queued bulk message is about (events after
 *   their subscription's snapshot: a client drops a snapshot that comes after its events);
 * - any delta (`events`, `progress`) while a page is queued: a page and later deltas of one
 *   thread are not tied by any id this router reads;
 * - anything at all while a message the router can't place is queued (a barrier), and
 *   `channel.close`, which goes last.
 *
 * A message held back joins the bulk lane, and its own ids hold back what follows it. The
 * relay only ever reorders messages with nothing in common, so what a client reads is a
 * valid order it could have been sent in. Pure; the socket tells it when a bulk message has
 * gone out in full.
 */

/** Types that are bulk, by the id that orders what follows them. */
const bulkBySubscription = new Set(["snapshot", "snapshot.part"]);
const bulkByRequest = new Set([
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
const deltas = new Set(["events", "progress"]);
/** Every message after any page: page and deltas share a thread, not an id. */
const PAGES = "pages";
/** A queued message whose place the router can't tell holds back everything. */
const BARRIER = "*";
/** Larger interactive messages are not parsed for their ids; they wait as barriers. */
const PARSE_LIMIT = 64 * 1024;

const TYPE_PREFIX = /^\{"type":"([^"\\]{1,64})"/;
const SECOND_KEY = /^,"(subscriptionId|requestId)":"([^"\\]{1,256})"/;

/** What one message is: its type and the ids that order it, or undefined when unknown. */
interface Facts {
  type: string;
  ids: string[] | undefined;
}

/** A bulk message's facts from its first two keys (the daemon writes `type` first). */
function prefixFacts(line: string): Facts | undefined {
  const type = TYPE_PREFIX.exec(line);
  if (!type?.[1]) return undefined;
  const key = SECOND_KEY.exec(line.slice(type[0].length));
  return {
    type: type[1],
    ids: key?.[1] && key[2] ? [`${key[1] === "requestId" ? "req" : "sub"}:${key[2]}`] : undefined,
  };
}

/** An interactive message's ids: its top-level subscription and request ids. */
function parsedIds(line: string): string[] | undefined {
  if (line.length > PARSE_LIMIT) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return undefined;
    const ids: string[] = [];
    if ("subscriptionId" in value && typeof value.subscriptionId === "string")
      ids.push(`sub:${value.subscriptionId}`);
    if ("requestId" in value && typeof value.requestId === "string")
      ids.push(`req:${value.requestId}`);
    return ids;
  } catch {
    return undefined;
  }
}

export interface Routed {
  lane: Lane;
  /** Call once the message has gone out in full (or the channel ended). */
  sent(): void;
}

const nothing = () => {};

export class LaneRouter {
  /** Ids held by messages queued in the bulk lane, counted. */
  readonly #held = new Map<string, number>();

  /** The lane for bytes the router can't read (a binary message): behind any bulk. */
  routeOpaque(): Routed {
    return this.#held.size === 0
      ? { lane: INTERACTIVE, sent: nothing }
      : this.#hold(new Set([BARRIER]));
  }

  /** The lane for one frame's text: one message, or several on their own lines. */
  route(text: string): Routed {
    const lines = text.includes("\n") ? text.split("\n") : [text];
    const keys = new Set<string>();
    let bulk = this.#held.has(BARRIER);
    const unread: string[] = [];
    for (const line of lines) {
      const facts = prefixFacts(line);
      const type = facts?.type;
      if (type !== undefined && (bulkBySubscription.has(type) || bulkByRequest.has(type))) {
        bulk = true;
        for (const id of facts?.ids ?? [BARRIER]) keys.add(id);
        if (bulkByRequest.has(type)) keys.add(PAGES);
        continue;
      }
      if (type === "channel.close") {
        bulk = true;
        keys.add(BARRIER);
        continue;
      }
      // Nothing queued in bulk: nothing to stay behind, nothing to read unless the frame waits.
      if (this.#held.size === 0) {
        unread.push(line);
        continue;
      }
      const ids = parsedIds(line);
      if (!ids) {
        // Can't tell what it belongs to: it waits, and so does what follows it.
        bulk = true;
        keys.add(BARRIER);
        continue;
      }
      for (const id of ids) keys.add(id);
      if (ids.some((id) => this.#held.has(id))) bulk = true;
      if (type !== undefined && deltas.has(type) && this.#held.has(PAGES)) bulk = true;
      // A message with no ids joining the bulk lane holds back all that follows.
      if (ids.length === 0) keys.add(BARRIER);
    }
    if (!bulk) return { lane: INTERACTIVE, sent: nothing };
    // A frame packing a bulk message with others: their ids wait with it.
    for (const line of unread) {
      const ids = parsedIds(line);
      for (const id of ids?.length ? ids : [BARRIER]) keys.add(id);
    }
    // Ordered behind the bulk lane but holding no id: it still keeps what follows behind it.
    if (keys.size === 0) keys.add(BARRIER);
    return this.#hold(keys);
  }

  #hold(keys: Set<string>): Routed {
    for (const key of keys) this.#held.set(key, (this.#held.get(key) ?? 0) + 1);
    let done = false;
    return {
      lane: BULK,
      sent: () => {
        if (done) return;
        done = true;
        for (const key of keys) {
          const count = (this.#held.get(key) ?? 0) - 1;
          if (count > 0) this.#held.set(key, count);
          else this.#held.delete(key);
        }
      },
    };
  }
}
