import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { NativeServices } from "./native-services.ts";
import { RecordingSink } from "./sheet-fixture.ts";

/* A picked accent colour reaches the phone fitted to every theme through the service bridge. */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function services(): Promise<{
  ask(id: string, request: unknown): void;
  sink: RecordingSink;
}> {
  const daemon = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
  });
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-accent-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  client = owner;
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  const sink = new RecordingSink();
  const bridge = new NativeServices(owner, sink);
  return { sink, ask: (id, request) => bridge.handle({ type: "service", id, request }) };
}

test("a picked colour comes back fitted to every theme in both schemes", async () => {
  const { ask, sink } = await services();
  ask("pick", { type: "appearance.customAccent", colour: "#ffe600" });
  await until(() => sink.read("service:pick"));
  const reply = sink.read("service:pick") as {
    ok: boolean;
    value: { colour: string; themes: Record<string, Record<string, { accent: string }>> };
  };
  expect(reply.ok).toBe(true);
  expect(reply.value.colour).toBe("#FFE600");
  expect(Object.keys(reply.value.themes).toSorted()).toEqual(
    ["ace", "dusk", "grove", "harbor", "midnight", "paper"].toSorted(),
  );
  // Saturated yellow can't be a light page's link as picked; it is deepened there.
  expect(reply.value.themes.ace?.light?.accent).not.toBe("#FFE600");
});

test("a colour that isn't one opaque hex colour is refused", async () => {
  const { ask, sink } = await services();
  ask("bad", { type: "appearance.customAccent", colour: "#ffe60080" });
  await until(() => sink.read("service:bad"));
  expect(sink.read("service:bad")).toMatchObject({ ok: false });
});
