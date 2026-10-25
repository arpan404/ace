import { afterEach, expect, test } from "vitest";
import { until } from "./sheet-fixture.ts";
import { forecast, linkedMac, said } from "./transfer-fixture.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function mac() {
  const app = linkedMac();
  close = app.close;
  return app.start();
}

test("progress made while the phone was disconnected shows once it reconnects", async () => {
  const app = await mac();
  app.openThread();
  app.agentContinues();
  await app.step();
  await until(
    () => said(app.thread()?.line)?.words === "Sending to Build server · 0 B of 1.2 GB",
    "sending",
  );

  // The daemon keeps sending while nothing hears its pushes.
  app.daemon.refuseConnections(true);
  for (let index = 0; index < 5; index++) await app.step();
  expect(app.daemon.transfers.list()[0]?.phase).toBe("importing");
  expect(said(app.thread()?.line)?.words).not.toBe("Setting up on Build server");

  app.daemon.refuseConnections(false);
  app.client.reconnectNow();
  await until(() => said(app.thread()?.line)?.words === "Setting up on Build server", "caught up");
});

test("after a reconnect the sheet waits for that connection's list, then shows the transfer started meanwhile", async () => {
  const app = await mac();
  app.daemon.refuseConnections(true);
  app.agentContinues();
  app.daemon.holdRequests("transfers.request");
  app.daemon.refuseConnections(false);
  app.client.reconnectNow();
  // Ready again, with this connection's list out (and held).
  await until(
    () => app.client.connectionState().getSnapshot() === "ready" && !app.transfers.store.seeded(),
    "ready again, list held",
  );

  app.act({ kind: "open", subject: forecast });
  expect(await app.sheetAt("checking")).toEqual({
    kind: "checking",
    words: "Checking what this machine is sending…",
  });

  app.daemon.restoreRequests();
  app.daemon.disconnectAll();
  app.client.reconnectNow();
  const status = await app.sheetAt("status");
  expect(said(status.line)?.words).toBe("Getting ready to send to Build server");
  expect(said(status.line)?.actions).toEqual(["Cancel"]);
});

test("machines already showing give way to a transfer the reconnect's list reports running", async () => {
  const app = await mac();
  app.act({ kind: "open", subject: forecast });
  await app.sheetAt("machines");

  app.daemon.refuseConnections(true);
  app.agentContinues();
  app.daemon.refuseConnections(false);
  app.client.reconnectNow();
  const status = await app.sheetAt("status");
  expect(status.machine).toEqual({ hostId: "build", name: "Build server" });
  // A second transfer is never offered while this one runs.
  app.act({ kind: "choose", hostId: "build" });
  expect(app.step$()?.kind).toBe("status");
});
