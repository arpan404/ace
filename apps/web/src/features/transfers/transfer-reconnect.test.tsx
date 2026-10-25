import { CommandId, DeviceId, HostId, ThreadId } from "@ace/protocol";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { continueOn, linkedMachines, strip } from "./transfer-fixture.tsx";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** An agent on this Mac continues the thread on the build server. */
function agentContinues(app: ReturnType<typeof linkedMachines>["app"]) {
  app.daemon.transfers.start({
    id: CommandId.parse("agent-transfer"),
    deviceId: DeviceId.parse("agent-device"),
    payload: {
      type: "thread.continueOn",
      threadId: ThreadId.parse("thread-forecast"),
      hostId: HostId.parse("build"),
      includeChanges: true,
    },
  });
}

test("progress made while the window was disconnected shows once it reconnects", async () => {
  const { app, step } = linkedMachines();
  await app.open("/t/thread-forecast");
  await screen.findByRole("button", { name: "More actions" });
  agentContinues(app);
  await step();
  expect(await strip("Sending to Build server · 0 B of 1.2 GB")).toBeTruthy();

  // The daemon keeps sending while nothing hears its pushes.
  act(() => app.daemon.refuseConnections(true));
  for (let index = 0; index < 5; index++) await step();
  expect(app.daemon.transfers.list()[0]?.phase).toBe("importing");
  expect(screen.queryByTitle("Setting up on Build server")).toBeNull();

  act(() => {
    app.daemon.refuseConnections(false);
    app.client.reconnectNow();
  });
  expect(await strip("Setting up on Build server")).toBeTruthy();
}, 30_000);

test("a transfer list that couldn't be read is read again on reconnect", async () => {
  const { app } = linkedMachines();
  app.daemon.failRequests("transfers.request");
  // Started before the window opened: only the list can tell it.
  agentContinues(app);
  await app.open("/t/thread-forecast");
  await screen.findByRole("button", { name: "More actions" });
  expect(screen.queryByTitle("Getting ready to send to Build server")).toBeNull();

  app.daemon.restoreRequests();
  act(() => {
    app.daemon.disconnectAll();
    app.client.reconnectNow();
  });
  expect(await strip("Getting ready to send to Build server")).toBeTruthy();
}, 30_000);

test("the chooser after a reconnect waits for that connection's list, then shows a transfer started meanwhile", async () => {
  const { app } = linkedMachines();
  await app.open("/t/thread-forecast");
  await screen.findByRole("button", { name: "More actions" });

  // Another window starts a transfer while this one is away; the next list is slow to answer.
  act(() => app.daemon.refuseConnections(true));
  agentContinues(app);
  app.daemon.holdRequests("transfers.request");
  act(() => {
    app.daemon.refuseConnections(false);
    app.client.reconnectNow();
  });
  // Ready again, so this connection's list is out (and held).
  await waitFor(() => expect(app.client.connectionState().getSnapshot()).toBe("ready"));

  const dialog = await continueOn();
  expect(await within(dialog).findByText("Checking what this machine is sending…")).toBeTruthy();
  expect(within(dialog).queryByRole("listbox", { name: "Machines" })).toBeNull();

  app.daemon.restoreRequests();
  act(() => {
    app.daemon.disconnectAll();
    app.client.reconnectNow();
  });
  expect(await within(dialog).findByText("Getting ready to send to Build server")).toBeTruthy();
  expect(within(dialog).queryByRole("listbox", { name: "Machines" })).toBeNull();
}, 30_000);

test("machines already showing give way to a transfer the reconnect's list reports running", async () => {
  const { app } = linkedMachines();
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  expect(await within(dialog).findByRole("option", { name: "Build server" })).toBeTruthy();

  act(() => app.daemon.refuseConnections(true));
  agentContinues(app);
  act(() => {
    app.daemon.refuseConnections(false);
    app.client.reconnectNow();
  });
  expect(await within(dialog).findByText("Getting ready to send to Build server")).toBeTruthy();
  expect(within(dialog).queryByRole("listbox", { name: "Machines" })).toBeNull();
}, 30_000);
