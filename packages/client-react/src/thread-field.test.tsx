import { Client } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, expect, test } from "vitest";
import { ClientProvider, useThreadMeta } from "./index.ts";
import { useThreadField, type ThreadRecord } from "./thread-field.ts";

const clients: Client[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function setup() {
  let now = 1;
  let ids = 0;
  const daemon = new FakeDaemon({ clock: () => (now += 1) });
  const client = new Client({
    deviceId: DeviceId.parse("thread-field-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++ids}`,
  });
  clients.push(client);
  return { daemon, client };
}

const pickWorkspace = (thread: ThreadRecord) => thread.workspaceId;
const pickTitle = (thread: ThreadRecord) => thread.title;

function Workspace() {
  return <output aria-label="workspace">{useThreadField("thread-field", pickWorkspace)}</output>;
}
function Whole() {
  return <output aria-label="title">{useThreadMeta("thread-field")?.title}</output>;
}
function Title() {
  return <output aria-label="picked title">{useThreadField("thread-field", pickTitle)}</output>;
}

test("a view reading one thread field re-renders only when that field changes", async () => {
  const { daemon, client } = setup();
  daemon.createThread({ id: "thread-field", workspaceId: "ws", title: "First", provider: "codex" });
  await client.start();
  const lease = client.thread("thread-field");
  const renders = { workspace: 0, whole: 0 };
  const counted = (id: string) => {
    if (id === "workspace" || id === "whole") renders[id]++;
  };
  render(
    <ClientProvider client={client}>
      <Profiler id="workspace" onRender={counted}>
        <Workspace />
      </Profiler>
      <Profiler id="whole" onRender={counted}>
        <Whole />
      </Profiler>
      <Title />
    </ClientProvider>,
  );
  await screen.findByText("ws");
  await screen.findAllByText("First");
  const before = { ...renders };

  // A metadata change that leaves the workspace as it was (as a tool step's update does).
  await act(async () => daemon.updateThread("thread-field", { title: "Second" }));
  expect(await screen.findAllByText("Second")).toHaveLength(2);
  expect(screen.getByLabelText("picked title").textContent).toBe("Second");
  expect(renders.whole).toBeGreaterThan(before.whole);
  expect(renders.workspace).toBe(before.workspace);
  lease.release();
});
