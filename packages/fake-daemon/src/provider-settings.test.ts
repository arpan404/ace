import { expect, test } from "vitest";
import { FakeServices } from "@ace/fake-daemon";
import { ClientMessage, ServerMessage, type ServerMessage as Message } from "@ace/protocol";

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
