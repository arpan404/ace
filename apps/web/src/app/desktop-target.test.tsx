import { Client, type ClientApi } from "@ace/client";
import { ClientProvider, useSidebarIds, useSidebarThread } from "@ace/client-react";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { memoryStorage } from "@/boot/client.ts";
import type { DaemonTarget } from "@/boot/connection-settings.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { ConnectionGate } from "./connection-gate.tsx";

const token = "ab".repeat(32);
const url = "ws://127.0.0.1:4242/";
const nextUrl = "ws://127.0.0.1:5555/";
const nextToken = "bc".repeat(32);
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  Reflect.deleteProperty(globalThis, "ace");
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

/** Distinct daemon facts make using a stale endpoint or credential visible on screen. */
function hosts() {
  const targets = new Map<string, FakeDaemon>();
  for (const [address, secret, title] of [
    [url, token, "Original desktop thread"],
    [nextUrl, nextToken, "Replacement desktop thread"],
    ["wss://remote.example/", token, "Remote machine thread"],
  ]) {
    if (!address || !secret || !title) throw new Error("Incomplete host fixture");
    const daemon = new FakeDaemon({ clock: () => 1, token: secret });
    daemon.createThread({ id: title, workspaceId: "ace", title, provider: "codex" });
    targets.set(address, daemon);
  }
  return (target: DaemonTarget) => {
    const daemon = targets.get(target.url);
    if (!daemon) throw new Error("Unknown daemon endpoint");
    const client = new Client({
      deviceId: DeviceId.parse("desktop-test"),
      transport: () => fakeTransport(daemon),
      credential: async () => target.token,
      storage: memoryStorage(),
      scheduler: { set: () => () => {} },
      random: () => 0.5,
      id: () => crypto.randomUUID(),
    });
    clients.push(client);
    return client;
  };
}
function ThreadTitle(props: { id: string }) {
  const thread = useSidebarThread(props.id);
  return <li>{thread?.title}</li>;
}
function Connected() {
  const ids = useSidebarIds();
  const connection = useDaemonConnection();
  const [draft, setDraft] = useState("");
  return (
    <>
      <ul>
        {ids?.map((id) => (
          <ThreadTitle key={id} id={id} />
        ))}
      </ul>
      <label>
        Draft
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <button
        onClick={() =>
          connection.connect(
            { url: "wss://remote.example/", token, pairedDeviceId: "remote-device" },
            false,
          )
        }
      >
        Remote machine
      </button>
    </>
  );
}
const connected = (client: ClientApi) => (
  <ClientProvider client={client}>
    <Connected />
  </ClientProvider>
);

test("same desktop credentials preserve the draft and changed credentials connect to the replacement host", async () => {
  const stores = { local: memoryKeyValue(), session: memoryKeyValue() };
  const createClient = hosts();
  const first = { url, token };
  const view = (handed: DaemonTarget) => (
    <ConnectionGate
      stores={stores}
      defaultUrl={url}
      handed={handed}
      desktop
      createClient={createClient}
    >
      {connected}
    </ConnectionGate>
  );
  const mounted = render(view(first));
  await screen.findByText("Original desktop thread");
  await userEvent.type(screen.getByLabelText("Draft"), "Keep my unsent draft");
  await act(async () => mounted.rerender(view({ ...first })));
  expect(screen.getByLabelText<HTMLInputElement>("Draft").value).toBe("Keep my unsent draft");
  mounted.rerender(view({ url: nextUrl, token: nextToken }));
  await screen.findByText("Replacement desktop thread");
  expect(screen.queryByText("Original desktop thread")).toBeNull();
  expect(screen.getByLabelText<HTMLInputElement>("Draft").value).toBe("");
});

test("manual remote selection and its draft survive a local desktop endpoint replacement", async () => {
  const stores = { local: memoryKeyValue(), session: memoryKeyValue() };
  const createClient = hosts();
  const view = (handed: DaemonTarget) => (
    <ConnectionGate
      stores={stores}
      defaultUrl={url}
      handed={handed}
      desktop
      createClient={createClient}
    >
      {connected}
    </ConnectionGate>
  );
  const mounted = render(view({ url, token }));
  await screen.findByText("Original desktop thread");
  await userEvent.click(screen.getByRole("button", { name: "Remote machine" }));
  await screen.findByText("Remote machine thread");
  await userEvent.type(screen.getByLabelText("Draft"), "Remote draft");
  await act(async () => mounted.rerender(view({ url: nextUrl, token: nextToken })));
  expect(screen.getByText("Remote machine thread")).toBeTruthy();
  expect(screen.queryByText("Replacement desktop thread")).toBeNull();
  expect(screen.getByLabelText<HTMLInputElement>("Draft").value).toBe("Remote draft");
});

test("a running desktop status connects the renderer to the replacement daemon's data", async () => {
  let target = { url, token };
  const statusListeners = new Set<(status: unknown) => void>();
  Reflect.set(globalThis, "ace", {
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
  });
  render(
    <ConnectionGate
      stores={{ local: memoryKeyValue(), session: memoryKeyValue() }}
      defaultUrl={url}
      handed={target}
      desktop
      createClient={hosts()}
    >
      {connected}
    </ConnectionGate>,
  );
  await screen.findByText("Original desktop thread");
  target = { url: nextUrl, token: nextToken };
  act(() => {
    for (const listener of statusListeners) listener({ state: "running" });
  });
  await screen.findByText("Replacement desktop thread");
  await waitFor(() => expect(screen.queryByText("Original desktop thread")).toBeNull());
});
