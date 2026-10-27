import "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { NativeServices } from "./native-services.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

test("native settings read and save use the selected daemon and retain validation errors", async () => {
  const { client } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const sink = new RecordingSink();
  const services = new NativeServices(client, sink);
  services.handle({
    type: "service",
    id: "save",
    request: {
      type: "settings.set",
      key: "threads.followUpBehavior",
      value: "queue",
      layer: { kind: "global" },
    },
  });
  await until(() => sink.read("service:save") !== undefined, "saved");
  expect(sink.read("service:save")).toMatchObject({
    ok: true,
    value: { ok: true, entries: [{ key: "threads.followUpBehavior", value: "queue" }] },
  });
  services.handle({
    type: "service",
    id: "read",
    request: { type: "settings.get", key: "threads.followUpBehavior", scope: {} },
  });
  await until(() => sink.read("service:read") !== undefined, "read");
  expect(sink.read("service:read")).toMatchObject({
    ok: true,
    value: { entries: [{ value: "queue" }] },
  });
  services.handle({
    type: "service",
    id: "invalid",
    request: {
      type: "settings.set",
      key: "threads.followUpBehavior",
      value: "bad",
      layer: { kind: "global" },
    },
  });
  await until(() => sink.read("service:invalid") !== undefined, "refused");
  expect(sink.read("service:invalid")).toMatchObject({ ok: true, value: { ok: false } });
});

test("native service bridge refuses thread commands so they cannot bypass durable admission", async () => {
  const { client } = sheetFixture();
  close = () => client.close();
  const sink = new RecordingSink();
  new NativeServices(client, sink).handle({
    type: "service",
    id: "bad",
    request: { type: "thread.send", threadId: "t", input: [{ type: "text", text: "hello" }] },
  });
  await until(() => sink.read("service:bad") !== undefined, "refused");
  expect(sink.read("service:bad")).toMatchObject({ ok: false, value: null });
});

test("an API key never leaves the phone, because ADR 0002 allows keys only over provider_auth", async () => {
  const { client } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.state === "ready", "connected");
  const sink = new RecordingSink();
  new NativeServices(client, sink).handle({
    type: "service",
    id: "key",
    request: { type: "provider.login.apiKey", session: "login-1", apiKey: "sk-test-123" },
  });
  await until(() => sink.read("service:key") !== undefined, "refused");
  // Refused in the bridge: a forwarded request would come back with the daemon's own answer.
  expect(sink.read("service:key")).toMatchObject({ ok: false, value: null });
  expect(JSON.stringify(sink.read("service:key"))).not.toContain("sk-test-123");
});

test("phone search finds message content beyond the loaded inbox titles", async () => {
  const { client } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.state === "ready", "connected");
  const sink = new RecordingSink();
  new NativeServices(client, sink).handle({
    type: "service",
    id: "search",
    request: { type: "search.query", text: "sequence number", filters: { kind: "message" } },
  });
  await until(() => sink.read("service:search") !== undefined, "searched");
  expect(sink.read("service:search")).toMatchObject({
    ok: true,
    value: {
      type: "search.results",
      hits: [
        expect.objectContaining({
          threadId: "thread-dedupe",
          snippet: expect.objectContaining({ text: expect.stringContaining("sequence number") }),
        }),
      ],
    },
  });
});
