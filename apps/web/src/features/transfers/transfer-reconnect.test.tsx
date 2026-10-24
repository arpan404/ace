import { CommandId, DeviceId, HostId, ThreadId } from "@ace/protocol";
import { act, configure, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { linkedMachines, strip } from "./transfer-fixture.tsx";

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
