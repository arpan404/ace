import type { DeliveryEvent, Item, ServerMessage, ThreadStatus } from "@ace/protocol";

/*
 * Thread statuses as a reader that predates the `moved` state (ADR 0191) can read them. Such a
 * reader's decoder rejects the whole message for the unknown state, so a client socket whose
 * hello doesn't list the `moved-status` trim, or a calling machine that doesn't accept it, gets
 * each moved status as `waiting` on `upstream`: the work goes on elsewhere, so the thread is
 * neither working here nor done, and the thread's `continuedOn` already names the machine it
 * went to. Those readers keep it unsettled, as a moved thread is.
 *
 * Only the fields that hold a thread status are read, in the message types that carry one (the
 * coverage test walks the wire schema for them); provider payloads (`raw`) are never looked
 * into. Any other message, a streamed delta among them, is returned as it came, and a message
 * without a moved status allocates nothing.
 */

/** What an older reader gets in place of `{ state: "moved", to }`. */
export function olderStatus(status: ThreadStatus): ThreadStatus {
  return status.state === "moved" ? { state: "waiting", on: "upstream" } : status;
}

type Events = Extract<ServerMessage, { type: "events" }>;
type Snapshot = Extract<ServerMessage, { type: "snapshot" }>;
type Turn = Extract<ServerMessage, { type: "turns.page" }>["turns"][number];

/** `message` with every moved thread status read as an older client can, or itself if none. */
export function olderStatuses<T extends { type: string }>(message: T): T {
  // Narrowed by `type`, and each case returns a message of the type it was given.
  return olderMessage(message as unknown as ServerMessage) as unknown as T;
}

function olderMessage(message: ServerMessage): ServerMessage {
  switch (message.type) {
    case "events": {
      const events = mapList(message.events, olderEvent);
      return events === message.events
        ? message
        : { ...message, events: events as Events["events"] };
    }
    case "threads.patch": {
      const threads = mapRecord(message.threads, olderListed);
      return threads === message.threads ? message : { ...message, threads };
    }
    case "snapshot":
      return olderSnapshot(message);
    case "items.page":
    case "items.window": {
      const items = mapList(message.items, olderItem);
      return items === message.items ? message : { ...message, items: [...items] };
    }
    case "turn.steps": {
      const steps = mapList(message.steps, (step) => {
        const item = olderItem(step.item);
        return item === step.item ? step : { ...step, item };
      });
      return steps === message.steps ? message : { ...message, steps: [...steps] };
    }
    case "turns.page": {
      const turns = mapList(message.turns, olderTurn);
      return turns === message.turns ? message : { ...message, turns: [...turns] };
    }
    case "thread.catchUp":
      return message.status.state === "moved"
        ? { ...message, status: olderStatus(message.status) }
        : message;
    case "search.results": {
      const hits = mapList(message.hits, (hit) =>
        hit.status === "moved" ? { ...hit, status: "waiting" as const } : hit,
      );
      return hits === message.hits ? message : { ...message, hits: [...hits] };
    }
    default:
      return message;
  }
}

function olderSnapshot(message: Snapshot): Snapshot {
  const { view } = message;
  if (view.kind === "threads") {
    const threads = mapRecord(view.threads, olderListed);
    return threads === view.threads ? message : { ...message, view: { ...view, threads } };
  }
  const thread = olderListed(view.thread);
  const items = view.items ? mapRecord(view.items, olderItem) : view.items;
  return thread === view.thread && items === view.items
    ? message
    : { ...message, view: { ...view, thread, items } };
}

function olderEvent(event: DeliveryEvent): DeliveryEvent {
  const { payload } = event;
  switch (payload.type) {
    case "thread.created": {
      const thread = olderListed(payload.thread);
      return thread === payload.thread ? event : { ...event, payload: { ...payload, thread } };
    }
    case "thread.updated":
      return payload.status?.state === "moved"
        ? { ...event, payload: { ...payload, status: olderStatus(payload.status) } }
        : event;
    case "item.created":
    case "item.updated": {
      const item = olderItem(payload.item);
      return item === payload.item ? event : { ...event, payload: { ...payload, item } };
    }
    default:
      return event;
  }
}

function olderListed<T extends { status: ThreadStatus }>(thread: T): T {
  return thread.status.state === "moved"
    ? { ...thread, status: olderStatus(thread.status) }
    : thread;
}

/** A delegation's child status; every other item, and every item's `raw`, as it came. */
function olderItem(item: Item): Item {
  return item.type === "delegation.started" && item.status.state === "moved"
    ? { ...item, status: olderStatus(item.status) }
    : item;
}

function olderTurn(turn: Turn): Turn {
  const subagents = mapList(turn.subagents, olderListed);
  const status = olderStatus(turn.status);
  return status === turn.status && subagents === turn.subagents
    ? turn
    : { ...turn, status, subagents: [...subagents] };
}

/** `list` with `change` applied, or `list` itself when it changed nothing. */
function mapList<T>(list: readonly T[], change: (value: T) => T): readonly T[] {
  let copy: T[] | undefined;
  for (let index = 0; index < list.length; index++) {
    const value = list[index] as T;
    const next = change(value);
    if (next === value) continue;
    copy ??= list.slice();
    copy[index] = next;
  }
  return copy ?? list;
}

/** `record` with `change` applied to each own value, or `record` itself when nothing changed. */
function mapRecord<T>(record: Record<string, T>, change: (value: T) => T): Record<string, T> {
  let copy: Record<string, T> | undefined;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key] as T;
    const next = change(value);
    if (next === value) continue;
    // Spread, then define: an id such as `__proto__` stays an own property.
    copy ??= { ...record };
    Object.defineProperty(copy, key, {
      value: next,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy ?? record;
}
