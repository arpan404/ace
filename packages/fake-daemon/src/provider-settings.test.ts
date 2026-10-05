import { expect, test } from "vitest";
import { FakeServices, FakeDaemon } from "@ace/fake-daemon";
import {
  ClientMessage,
  Command,
  ServerMessage,
  type ServerMessage as Message,
} from "@ace/protocol";

test("fake settings sync to both devices and list hidden choices with refresh progress", async () => {
  const services = new FakeServices({ clock: () => 123, thread: () => undefined });
  const first: Message[] = [];
  const second: Message[] = [];
  const push = (message: Message) => first.push(ServerMessage.parse(message));
  const pushSecond = (message: Message) => second.push(ServerMessage.parse(message));
  for (const [subscriptionId, send] of [
    ["first", push],
    ["second", pushSecond],
  ] as const)
    services.handle(
      ClientMessage.parse({
        type: "settings.subscribe",
        requestId: subscriptionId,
        subscriptionId,
        scope: {},
        keys: ["providers.configuration"],
      }),
      send,
    );
  const model = services.models[0];
  if (!model) throw new Error("Fixture has no models");
  services.handle(
    ClientMessage.parse({
      type: "settings.set",
      requestId: "set",
      layer: { kind: "global" },
      key: "providers.configuration",
      value: [{ provider: model.provider, hiddenModels: [model.id] }],
    }),
    push,
  );
  expect(second.at(-1)).toMatchObject({
    type: "settings.changed",
    entries: [{ key: "providers.configuration", value: [{ hiddenModels: [model.id] }] }],
  });
  services.handle(
    ClientMessage.parse({
      type: "models.list",
      requestId: "list",
      options: { instance: model.instance },
    }),
    push,
  );
  expect(first.at(-1)).toMatchObject({
    type: "models.result",
    result: {
      models: expect.arrayContaining([expect.objectContaining({ id: model.id, hidden: true })]),
    },
  });
  services.handle(
    ClientMessage.parse({
      type: "models.refresh",
      requestId: "refresh",
      filter: { instance: model.instance },
    }),
    push,
  );
  services.handle(
    ClientMessage.parse({
      type: "models.list",
      requestId: "progress",
      options: { instance: model.instance },
    }),
    push,
  );
  expect(first.at(-1)).toMatchObject({
    type: "models.result",
    result: { instances: [{ refreshing: true }] },
  });
  await Promise.resolve();
  expect(first.at(-1)).toMatchObject({
    type: "models.result",
    requestId: "refresh",
    result: { instances: [{ refreshing: false, lastRefreshedAt: 123 }] },
  });
});

test("fake admission checks default Cursor accounts and preserves explicit account identity for later work", () => {
  const daemon = new FakeDaemon({ clock: () => 123 });
  const account = daemon.services.accounts.find((row) => row.provider === "cursor");
  if (!account) throw new Error("Missing Cursor fixture account");
  daemon.services.settings.seed({
    "providers.configuration": [{ provider: "cursor", instance: account.id, enabled: false }],
  });
  const command = (id: string, payload: unknown) =>
    daemon.command(Command.parse({ id, deviceId: "device", payload }));
  const create = {
    type: "thread.create",
    provider: "cursor",
    workspaceId: "workspace",
    input: [{ type: "text", text: "new" }],
  };
  expect(command("default", create)).toMatchObject({ ok: false, error: "provider_disabled" });
  const explicit = command("explicit", { ...create, accountId: "explicit-account" });
  expect(explicit).toMatchObject({ ok: true });
  if (!explicit.threadId) throw new Error("Missing explicit account thread");
  daemon.services.settings.seed({
    "providers.configuration": [
      { provider: "cursor", instance: "explicit-account", enabled: false },
    ],
  });
  expect(
    command("next", {
      type: "thread.send",
      threadId: explicit.threadId,
      input: [{ type: "text", text: "next" }],
    }),
  ).toMatchObject({ ok: false, error: "provider_disabled" });
  expect(daemon.snapshot({ kind: "thread", threadId: explicit.threadId })).toMatchObject({
    thread: { live: { account: "explicit-account" } },
  });
  expect(command("stop", { type: "thread.interrupt", threadId: explicit.threadId })).toMatchObject({
    ok: true,
  });
});
