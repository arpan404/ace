import { afterEach, expect, test } from "vitest";
import { AgentId, Capabilities, ClientMessage, ItemId } from "@ace/protocol";
import { setup, ready, when } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const capabilities = Capabilities.parse({
  steer: true,
  interruptCascades: true,
  resume: true,
  fork: true,
  subagentTranscripts: true,
  backgroundTaskControl: true,
  backgroundVisibility: "full",
  planMode: true,
  tokenUsage: true,
  imageInput: true,
  rewindFiles: false,
  launchOptions: ["effort"],
});

test("a thread opened through the real daemon keeps its capabilities and items though the wire omits them", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  h.daemon.store.appendEvents(h.thread.id, [{ type: "thread.updated", capabilities }]);
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "item.created",
      item: {
        type: "message",
        id: ItemId.parse("m1"),
        agentId: AgentId.parse("a"),
        role: "assistant",
        createdAt: 1,
        complete: true,
        synthetic: false,
        raw: [],
        parts: [{ type: "text", text: "hello" }],
      },
    },
  ]);
  const { client, faults } = h.make();
  const frames: string[] = [];
  faults.incoming = (_message, text, deliver) => {
    frames.push(text);
    deliver(text);
  };
  await ready(client);
  const lease = client.thread(h.thread.id);
  const thread = await when(
    lease.store.select(["thread"], (reader) => reader.thread),
    (value) => value?.capabilities !== undefined,
  );

  expect(thread?.capabilities).toEqual(capabilities);
  expect(thread).not.toHaveProperty("capabilitiesRef");
  expect(lease.store.item("m1")).toMatchObject({ complete: true, synthetic: false, raw: [] });

  const snapshot = frames.find((text) => text.includes('"type":"snapshot"')) ?? "";
  expect(snapshot).toContain("capabilitiesRef");
  expect(snapshot).not.toContain('"steerTiming"');
  expect(snapshot).not.toContain('"backgroundVisibility"');
  expect(snapshot).not.toContain('"complete"');
  expect(frames.some((text) => text.includes('"type":"provider.capabilities"'))).toBe(true);
});

test("a client opens its connection by listing the trims it can undo", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make();
  await ready(client);
  const hello = faults.sent
    .map((text) => ClientMessage.parse(JSON.parse(text)))
    .find((message) => message.type === "hello");
  expect(hello).toMatchObject({ trims: ["item-defaults", "provider-capabilities"] });
});
