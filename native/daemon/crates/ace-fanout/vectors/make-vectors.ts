// SPDX-License-Identifier: Apache-2.0

/*
 * Produces `wire-encoder.json`, the byte fixtures T3's Rust encoder is proved against.
 *
 *   bun native/daemon/crates/ace-fanout/vectors/make-vectors.ts
 *
 * Every expected string is what `WireEncoder`/`EventEncodings` from
 * `apps/daemon/src/wire-encoder.ts` produced on the event shapes below (whole, short
 * deltas, raw-on-demand). The Rust test (`tests/vectors.rs`) encodes the same inputs and
 * compares byte for byte, so a divergence in key order, number printing, string escaping or
 * trimming fails there.
 */

import { join } from "node:path";
import { DeliveryEvent, type ServerMessage } from "@ace/protocol";
import { EventEncodings } from "../../../../../apps/daemon/src/event-encodings.ts";
import { WireEncoder, type EventShape } from "../../../../../apps/daemon/src/wire-encoder.ts";
import { writeVectors } from "../../../vectors/vectors-io.ts";

type Events = Extract<ServerMessage, { type: "events" }>;

const whole: EventShape = { rawOnDemand: false, shortDeltas: false };
const shapes: Record<string, EventShape> = {
  whole,
  rawOnDemand: { rawOnDemand: true, shortDeltas: false },
  shortDeltas: { rawOnDemand: false, shortDeltas: true },
  every: { rawOnDemand: true, shortDeltas: true },
};

const encodings = new EventEncodings();
const encoder = new WireEncoder(encodings);

const parse = (text: string): DeliveryEvent => DeliveryEvent.parse(JSON.parse(text));

/**
 * The event as the daemon holds it: `Event.parse`'s key order (`seq`, `id`, `at`, `threadId`,
 * `payload`, then `firstSeq`) and its defaults (`complete`, `synthetic`), which is what every
 * store read hands the encoder. The fixture's input text is this shape, so the Rust encoder
 * never sees an order production doesn't produce.
 */
const canonical = (event: DeliveryEvent): string => JSON.stringify(event);

/** Each event as the exact JSON text the store's publication holds. */
const eventTexts: Record<string, string> = {
  "thread.updated": JSON.stringify({
    id: "e1",
    seq: 4,
    at: 1,
    threadId: "t",
    payload: { type: "thread.updated", title: 'quotes " \\ \n 😀' },
  }),
  "thread.updated.plain": JSON.stringify({
    id: "e2",
    seq: 1,
    at: 1,
    threadId: "t",
    payload: { type: "thread.updated", title: "plain" },
  }),
  "thread.updated.lone": JSON.stringify({
    id: "e3",
    seq: 2,
    at: 1,
    threadId: "t",
    payload: { type: "thread.updated", title: "\ud800" },
  }),
  "message.created": JSON.stringify({
    id: "e4",
    seq: 5,
    at: 1731600000005,
    threadId: "thread-1",
    payload: {
      type: "item.created",
      item: {
        id: "m1",
        agentId: "a",
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
        createdAt: 1,
        raw: [{ type: "message_stop", data: { blob: "A".repeat(64) } }],
      },
    },
  }),
  "tool.created.mcp": JSON.stringify({
    id: "e5",
    seq: 6,
    at: 1731600000006,
    threadId: "thread-1",
    payload: {
      type: "item.created",
      item: {
        id: "ace",
        agentId: "a",
        type: "tool_call",
        call: {
          id: "ace",
          agentId: "a",
          kind: "mcp",
          title: "thread_start",
          status: "succeeded",
          detail: { kind: "mcp", server: "ace", tool: "thread_start" },
          startedAt: 1,
          raw: [{ type: "message_stop", data: { blob: "B".repeat(32) } }],
        },
        createdAt: 1,
        raw: [],
      },
    },
  }),
  "tool.updated.shell": JSON.stringify({
    id: "e6",
    seq: 7,
    at: 1731600000007,
    threadId: "thread-1",
    payload: {
      type: "item.updated",
      item: {
        id: "shell",
        agentId: "a",
        type: "tool_call",
        call: {
          id: "shell",
          agentId: "a",
          kind: "shell",
          title: "ls",
          status: "succeeded",
          detail: { kind: "shell", command: "ls" },
          startedAt: 1,
          raw: [{ type: "message_stop", data: { blob: "C".repeat(32) } }],
        },
        createdAt: 1,
        raw: [],
      },
    },
  }),
  delta: JSON.stringify({
    id: "stored-5",
    seq: 5,
    at: 1731600000005,
    threadId: "thread-1",
    payload: {
      type: "item.delta",
      itemId: "reply",
      agentId: "a",
      field: "text",
      append: 'quote " and \n 😀',
    },
  }),
  "delta.first": JSON.stringify({
    id: "stored-8",
    seq: 8,
    firstSeq: 6,
    at: 1731600000008,
    threadId: "thread-1",
    payload: { type: "item.delta", itemId: "reply", agentId: "a", field: "text", append: "tail" },
  }),
  "delta.other": JSON.stringify({
    id: "stored-9",
    seq: 9,
    at: 1731600000009,
    threadId: "thread-2",
    payload: { type: "item.delta", itemId: "reply", agentId: "a", field: "text", append: "other" },
  }),
};

const encoded = Object.entries(eventTexts).map(([name, text]) => {
  const event = parse(text);
  return {
    name,
    event: canonical(event),
    whole: encodings.json(event),
    bytes: encodings.bytes(event),
    trimmed: encodings.trimmedJson(event),
    trimmedBytes: encodings.trimmedBytes(event),
  };
});

function eventsMessage(
  name: string,
  events: DeliveryEvent[],
  extra: { afterSeq?: number; subscriptionId?: string; early?: boolean } = {},
): Record<string, unknown> {
  const message: Events = {
    type: "events",
    subscriptionId: extra.subscriptionId ?? "s",
    afterSeq: extra.afterSeq ?? 0,
    throughSeq: events.at(-1)?.seq ?? 0,
    ...(extra.early ? { early: true as const } : {}),
    events,
  };
  const perShape = Object.fromEntries(
    Object.entries(shapes).map(([shapeName, shape]) => {
      const frames = encoder.split(message, shape);
      return [
        shapeName,
        {
          encoded: encoder.encode(message, shape),
          encodedBytes: encoder.encodedBytes(message, shape),
          frames: frames.map((frame) => encoder.encode(frame, shape)),
        },
      ];
    }),
  );
  return {
    name,
    subscriptionId: message.subscriptionId,
    afterSeq: message.afterSeq,
    throughSeq: message.throughSeq,
    early: message.early === true,
    events: events.map((event) => JSON.stringify(event)),
    shapes: perShape,
  };
}

const big = (seq: number, size: number): DeliveryEvent =>
  parse(
    JSON.stringify({
      id: `big-${seq}`,
      seq,
      at: 1731600000000 + seq,
      threadId: "thread-1",
      payload: {
        type: "item.created",
        item: {
          id: `m${seq}`,
          agentId: "a",
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "x".repeat(size) }],
          createdAt: 1,
          raw: [],
        },
      },
    }),
  );

const messages = [
  eventsMessage("empty", []),
  eventsMessage("one", [parse(eventTexts["thread.updated.plain"] ?? "")]),
  eventsMessage(
    "unicode",
    [
      parse(eventTexts["thread.updated.plain"] ?? ""),
      parse(eventTexts["thread.updated.lone"] ?? ""),
      parse(eventTexts["thread.updated"] ?? ""),
    ],
    { subscriptionId: 'sub "é"' },
  ),
  eventsMessage("early", [parse(eventTexts.delta ?? ""), parse(eventTexts["delta.first"] ?? "")], {
    early: true,
    afterSeq: 4,
  }),
  eventsMessage("deltas.twoThreads", [
    parse(eventTexts.delta ?? ""),
    parse(eventTexts["delta.other"] ?? ""),
  ]),
  eventsMessage("raw.trim", [
    parse(eventTexts["message.created"] ?? ""),
    parse(eventTexts["tool.created.mcp"] ?? ""),
    parse(eventTexts["tool.updated.shell"] ?? ""),
  ]),
  // One frame holds the first two events; the third crosses the 1 MiB boundary.
  eventsMessage("split", [big(1, 600_000), big(2, 600_000), big(3, 20)]),
  // A single event over the frame size still travels alone.
  eventsMessage("oversized", [big(1, 1_048_600), big(2, 10)]),
];

const out = { encodings: encoded, messages };
writeVectors(join(import.meta.dir, "wire-encoder.json"), out);
