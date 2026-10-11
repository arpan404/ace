import { waitFor } from "@testing-library/react";
import { Client } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, ServerMessage } from "@ace/protocol";
import { expect, test } from "vitest";
import { daemonValues } from "@/features/settings/data/daemon-values.ts";
import { watchSettings } from "./settings-watch.ts";

function connection(refuseFirst = false) {
  const daemon = new FakeDaemon({ clock: () => 1 });
  let refused = false;
  const answered = Promise.withResolvers<void>();
  const client = new Client({
    deviceId: DeviceId.parse("settings-tab"),
    credential: async () => daemon.token,
    transport: () => {
      const inner = fakeTransport(daemon);
      return {
        ...inner,
        open(events) {
          inner.open({
            ...events,
            message(text) {
              const message = ServerMessage.parse(JSON.parse(text));
              if (refuseFirst && !refused && message.type === "settings.result") {
                refused = true;
                events.message(JSON.stringify({ ...message, ok: false, entries: [] }));
                answered.resolve();
              } else events.message(text);
            },
          });
        },
      };
    },
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delay, run) {
        const id = setTimeout(run, delay);
        return () => clearTimeout(id);
      },
    },
    random: () => 0.5,
    id: () => crypto.randomUUID(),
  });
  return { client, answered: answered.promise };
}

test("a refused settings subscription retries on the same live connection", async () => {
  const { client, answered } = connection(true);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const loaded = Promise.withResolvers<unknown>();
  const scheduled = Promise.withResolvers<() => void>();
  const stop = watchSettings(
    client,
    ["threads.useWorktree"],
    {},
    (entries) => loaded.resolve(entries[0]?.value),
    {
      set(_delay, run) {
        scheduled.resolve(run);
        return () => {};
      },
    },
  );
  try {
    await answered;
    const retry = await scheduled.promise;
    retry();
    expect(await loaded.promise).toBe(true);
  } finally {
    stop();
    await client.close();
  }
});

test("two settings mirrors on a shared socket keep receiving their own changes", async () => {
  const { client } = connection();
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const first = daemonValues(client, ["threads.useWorktree"]);
  const second = daemonValues(client, ["threads.settleOnClose"]);
  const worktree = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  const stops = [
    first.subscribe(() => {
      if (first.get()["threads.useWorktree"] === false) worktree.resolve();
    }),
    second.subscribe(() => {
      if (second.get()["threads.settleOnClose"] === true) settle.resolve();
    }),
  ];
  try {
    await client.request({
      type: "settings.set",
      key: "threads.useWorktree",
      value: false,
      layer: { kind: "global" },
    });
    await client.request({
      type: "settings.set",
      key: "threads.settleOnClose",
      value: true,
      layer: { kind: "global" },
    });
    await Promise.all([worktree.promise, settle.promise]);
    expect(first.get()["threads.useWorktree"]).toBe(false);
    expect(second.get()["threads.settleOnClose"]).toBe(true);
  } finally {
    for (const stop of stops) stop();
    await client.close();
  }
});
