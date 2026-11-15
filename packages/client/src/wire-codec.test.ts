import { DeviceId, type ServerMessage } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** Service schemas that arrive only when the test lets them. */
class GatedCodec extends WireCodec {
  gate = Promise.withResolvers<void>();
  override load() {
    return this.gate.promise.then(() => super.load());
  }
}

function connection(codec: WireCodec) {
  let events: TransportEvents | undefined;
  const sent: string[] = [];
  const received: ServerMessage["type"][] = [];
  const link = new Connection(
    {
      deviceId: DeviceId.parse("codec-device"),
      transport: () => ({
        open(next) {
          events = next;
          next.open();
        },
        send: (text) => sent.push(text),
        close() {},
      }),
      credential: async () => "a".repeat(64),
      storage: { load: async () => null, save: async () => {} },
      scheduler: { set: () => () => {} },
      random: () => 0.5,
      id: () => "id",
    },
    codec,
    defaultLimits,
    (message) => received.push(message.type),
    () => {},
    () => {},
  );
  const frame = (message: object) => events?.message(JSON.stringify(message));
  return { link, received, sent, frame };
}

test("a service message that beats its schemas waits for them, and frames after it keep their order", async () => {
  const codec = new GatedCodec();
  const { link, received, frame } = connection(codec);
  link.start();
  frame({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 });
  frame({ type: "settings.changed", subscriptionId: "settings", entries: [] });
  frame({ type: "pong" });
  expect(received).toEqual(["welcome"]);
  codec.gate.resolve();
  await codec.load();
  await Promise.resolve();
  expect(received).toEqual(["welcome", "settings.changed", "pong"]);
  expect(link.state).toBe("ready");
});

test("a malformed service message is still refused once the schemas have loaded", async () => {
  const codec = new GatedCodec();
  const { link, frame, received } = connection(codec);
  link.start();
  frame({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 });
  frame({ type: "settings.changed", subscriptionId: "settings", entries: "not a list" });
  codec.gate.resolve();
  await codec.load();
  await Promise.resolve();
  expect(received).toEqual(["welcome"]);
  // A frame of another build drops the socket and retries; it never strands the session.
  expect(link.state).toBe("reconnecting");
  expect(link.error?.code).toBe("version_mismatch");
});

test("imported thread provenance is decoded and validated before history service schemas load", () => {
  const codec = new WireCodec();
  const imported = {
    sourceId: "source",
    instanceId: "account",
    native: { provider: "codex", nativeId: "native" },
    importedAt: 1,
  };
  const thread = {
    id: "thread",
    workspaceId: "workspace",
    title: "Imported",
    provider: "codex",
    status: { state: "done" },
    createdAt: 1,
    updatedAt: 1,
    imported,
  };
  const value = (provenance: object) => ({
    type: "snapshot",
    subscriptionId: "sub",
    seq: 0,
    view: { kind: "threads", seq: 0, threads: { thread: { ...thread, imported: provenance } } },
  });
  expect(codec.decode(value(imported))).toMatchObject({
    view: { threads: { thread: { imported } } },
  });
  expect(() => codec.decode(value({ ...imported, sourceId: "" }))).toThrow();
});

test("a short-deltas events frame decodes to the same deltas as the whole frame", () => {
  const whole = {
    type: "events",
    subscriptionId: "s",
    afterSeq: 4,
    throughSeq: 6,
    events: [
      {
        id: "stored-5",
        seq: 5,
        at: 77,
        threadId: "t",
        payload: { type: "thread.updated", title: "Renamed" },
      },
      {
        id: "stored-6",
        seq: 6,
        at: 78,
        threadId: "t",
        payload: { type: "item.delta", itemId: "m", agentId: "a", field: "text", append: "é\n" },
      },
    ],
  };
  const [titled] = whole.events;
  const short = {
    ...whole,
    threadId: "t",
    events: [titled, { seq: 6, at: 78, d: ["m", "a", "text", "é\n"] }],
  };
  const codec = new WireCodec();
  const decoded = codec.decode(JSON.parse(JSON.stringify(short)));
  const expected = codec.decode(whole);
  if (decoded?.type !== "events" || expected?.type !== "events") throw new Error("shape");
  // Only the delta's event id, which no reader uses, differs.
  expect(decoded.events[0]).toEqual(expected.events[0]);
  const { id: _short, ...delta } = decoded.events[1] ?? {};
  const { id: _whole, ...stored } = expected.events[1] ?? {};
  expect(delta).toEqual(stored);
});
