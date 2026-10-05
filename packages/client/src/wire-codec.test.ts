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
  const { link, frame } = connection(codec);
  link.start();
  frame({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 });
  frame({ type: "settings.changed", subscriptionId: "settings", entries: "not a list" });
  codec.gate.resolve();
  await codec.load();
  await Promise.resolve();
  expect(link.state).toBe("fatal");
  expect(link.error?.code).toBe("protocol");
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
