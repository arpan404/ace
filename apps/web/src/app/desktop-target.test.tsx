import { Client } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { memoryStorage } from "@/boot/client.ts";
import type { DaemonTarget } from "@/boot/connection-settings.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { ConnectionGate } from "./connection-gate.tsx";

const token = "ab".repeat(32);
const url = "ws://127.0.0.1:4242/";
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});
function memoryKeyValue() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
function fakeClient(daemon: FakeDaemon) {
  const client = new Client({
    deviceId: DeviceId.parse("desktop-test"),
    transport: () => fakeTransport(daemon),
    credential: async () => token,
    storage: memoryStorage(),
    scheduler: { set: () => () => {} },
    random: () => 0.5,
    id: () => crypto.randomUUID(),
  });
  clients.push(client);
  return client;
}

test("desktop target changes replace the client, while same-target restarts keep it", async () => {
  const stores = { local: memoryKeyValue(), session: memoryKeyValue() };
  const daemon = new FakeDaemon({ clock: () => 1, token });
  const made: { target: DaemonTarget; client: Client }[] = [];
  const createClient = (target: DaemonTarget) => {
    const client = fakeClient(daemon);
    made.push({ target, client });
    return client;
  };
  const first = { url, token };
  const second = { url: "ws://127.0.0.1:5555/", token: "bc".repeat(32) };
  const view = (handed: DaemonTarget) => (
    <ConnectionGate
      stores={stores}
      defaultUrl={url}
      handed={handed}
      desktop
      createClient={createClient}
    >
      {() => <div>Connected app</div>}
    </ConnectionGate>
  );
  const mounted = render(view(first));
  await screen.findByText("Connected app");
  mounted.rerender(view({ ...first }));
  expect(made).toHaveLength(1);
  mounted.rerender(view(second));
  await waitFor(() => expect(made.map((entry) => entry.target)).toEqual([first, second]));
  expect(made[0]?.client.state).toBe("offline");
});

test("manual remote selection is preserved when the local desktop endpoint changes", async () => {
  const stores = { local: memoryKeyValue(), session: memoryKeyValue() };
  const daemon = new FakeDaemon({ clock: () => 1, token });
  const made: DaemonTarget[] = [];
  const createClient = (target: DaemonTarget) => {
    made.push(target);
    return fakeClient(daemon);
  };
  function Switch() {
    const connection = useDaemonConnection();
    return (
      <button onClick={() => connection.connect({ url: "wss://remote.example/", token }, false)}>
        Remote machine
      </button>
    );
  }
  const view = (handed: DaemonTarget) => (
    <ConnectionGate
      stores={stores}
      defaultUrl={url}
      handed={handed}
      desktop
      createClient={createClient}
    >
      {() => <Switch />}
    </ConnectionGate>
  );
  const mounted = render(view({ url, token }));
  await userEvent.click(await screen.findByRole("button", { name: "Remote machine" }));
  await waitFor(() => expect(made).toHaveLength(2));
  mounted.rerender(view({ url: "ws://127.0.0.1:5555/", token }));
  expect(made.at(-1)?.url).toBe("wss://remote.example/");
  expect(made).toHaveLength(2);
});

test("running desktop status hands a replacement address to the connected renderer", async () => {
  const daemon = new FakeDaemon({ clock: () => 1, token });
  let target = { url, token };
  const statusListeners = new Set<(status: unknown) => void>();
  const ace = {
    platform: "darwin",
    daemon: {
      status: async () => ({ state: "running" }),
      connection: async () => ({ mode: "daemon", ...target }),
      onStatus: (listener: (status: unknown) => void) => {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
        };
      },
    },
  };
  Reflect.set(globalThis, "ace", ace);
  const made: DaemonTarget[] = [];
  try {
    render(
      <ConnectionGate
        stores={{ local: memoryKeyValue(), session: memoryKeyValue() }}
        defaultUrl={url}
        handed={target}
        desktop
        createClient={(next) => {
          made.push(next);
          return fakeClient(daemon);
        }}
      >
        {() => <div>Connected desktop</div>}
      </ConnectionGate>,
    );
    await screen.findByText("Connected desktop");
    target = { url: "ws://127.0.0.1:5555/", token: "bc".repeat(32) };
    act(() => {
      for (const listener of statusListeners) listener({ state: "running" });
    });
    await waitFor(() => expect(made.at(-1)).toEqual(target));
  } finally {
    Reflect.deleteProperty(globalThis, "ace");
  }
});
