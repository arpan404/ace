import { expect, test } from "vitest";
import { Event, ServerMessage } from "@ace/protocol";
import { WireEncoder } from "./wire-encoder.ts";

test("fan-out preserves per-subscription cursors and escaped Unicode payloads", () => {
  const encoder = new WireEncoder();
  const event = Event.parse({
    id: "e",
    seq: 4,
    at: 1,
    threadId: "t",
    payload: { type: "thread.updated", title: 'quotes " \\ \n 😀' },
  });
  for (const subscriptionId of ["a", 'quoted"\n', "b"]) {
    const message = {
      type: "events",
      subscriptionId,
      afterSeq: 2,
      throughSeq: 4,
      events: [event],
    } satisfies ServerMessage;
    expect(ServerMessage.parse(JSON.parse(encoder.encode(message)))).toEqual(message);
  }
});

test("an events frame's measured size is its encoded size", () => {
  const encoder = new WireEncoder();
  const event = (seq: number, title: string) =>
    Event.parse({
      id: `e${seq}`,
      seq,
      at: 1,
      threadId: "t",
      payload: { type: "thread.updated", title },
    });
  for (const events of [
    [],
    [event(1, "plain")],
    [event(1, 'é " 😀 \n'), event(2, "\ud800"), event(3, "z")],
  ]) {
    const message = {
      type: "events",
      subscriptionId: 'sub "é"',
      afterSeq: 0,
      throughSeq: 3,
      events,
    } satisfies ServerMessage;
    expect(encoder.encodedBytes(message)).toBe(Buffer.byteLength(encoder.encode(message)));
  }
});

test("an event whose payload is replaced after it was sent is sent with the new payload", () => {
  const encoder = new WireEncoder();
  const event = Event.parse({
    id: "e",
    seq: 1,
    at: 1,
    threadId: "t",
    payload: { type: "thread.updated", title: "inline" },
  });
  const message = (events: Event[]) =>
    ({
      type: "events",
      subscriptionId: "s",
      afterSeq: 0,
      throughSeq: 1,
      events,
    }) satisfies ServerMessage;
  encoder.encode(message([event]));
  // Storing an event may swap its payload for a capped copy.
  event.payload = { type: "thread.updated", title: "capped" };
  const sent = ServerMessage.parse(JSON.parse(encoder.encode(message([event]))));
  expect(sent).toEqual(message([event]));
  expect(encoder.eventBytes(event)).toBe(Buffer.byteLength(JSON.stringify(event)));
});
