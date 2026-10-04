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
