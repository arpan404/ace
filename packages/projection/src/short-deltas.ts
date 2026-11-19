import type { DeliveryEvent } from "@ace/protocol";

/*
 * The `short-deltas` framing (hello `framing`): inside an events message that names its thread
 * once (`threadId` beside `subscriptionId`), a streamed delta goes as
 * `{"seq":…,"firstSeq"?:…,"at":…,"d":[itemId, agentId, field, append]}`. The thread comes from
 * the message, order and identity from `seq`. The event id is left out: no client reads a
 * delta's id (dedupe, resume and order go by `seq`), so a reader gives it `~<seq>`.
 * Both sides are pure: the daemon encodes, the client expands before parsing.
 */

export const shortDeltasFraming = "short-deltas";

type Delta = DeliveryEvent & { payload: Extract<DeliveryEvent["payload"], { type: "item.delta" }> };

const isDelta = (event: DeliveryEvent): event is Delta => event.payload.type === "item.delta";

/** The JSON of `event` in short form, or undefined for an event that isn't a delta. */
export function shortDeltaJson(event: DeliveryEvent): string | undefined {
  if (!isDelta(event)) return undefined;
  const { itemId, agentId, field, append } = event.payload;
  return JSON.stringify({
    seq: event.seq,
    ...(event.firstSeq === undefined ? {} : { firstSeq: event.firstSeq }),
    at: event.at,
    d: [itemId, agentId, field, append],
  });
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function expand(event: unknown, threadId: string): unknown {
  if (!record(event) || !Array.isArray(event.d) || typeof event.seq !== "number") return event;
  const [itemId, agentId, field, append] = event.d as unknown[];
  const { d: _short, ...rest } = event;
  return {
    id: `~${event.seq}`,
    ...rest,
    threadId,
    payload: { type: "item.delta", itemId, agentId, field, append },
  };
}

/**
 * A server message's JSON value with its short deltas whole again; any other value as it came.
 * Nothing is checked here: the expanded message is parsed with the full schema after.
 */
export function expandShortDeltas(value: unknown): unknown {
  if (!record(value) || value.type !== "events" || typeof value.threadId !== "string") return value;
  const { threadId, events, ...rest } = value;
  if (!Array.isArray(events)) return value;
  return { ...rest, events: events.map((event) => expand(event, threadId)) };
}
