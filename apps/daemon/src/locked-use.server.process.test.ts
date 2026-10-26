import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { SettingsService, fileIO } from "@ace/settings";
import { ServerMessage, type LockedUseStatus } from "@ace/protocol";
import type { LockedUseInstaller } from "@ace/screen";
import { ticketSocket } from "./client-access.ts";
import { cleanups, identity, setup } from "./remote-test-support.ts";
import { fixture } from "./socket-test-support.ts";

/** A Mac whose component the test controls: install turns it on, remove turns it off. */
function fakeMac(initial: LockedUseStatus = { state: "off" }) {
  let status = initial;
  const listeners = new Set<(status: LockedUseStatus) => void>();
  const set = (next: LockedUseStatus) => {
    status = next;
    for (const listener of listeners) listener(next);
    return Promise.resolve(next);
  };
  const installer: LockedUseInstaller = {
    detectStatus: () => Promise.resolve(status),
    install: () => set({ state: "on" }),
    remove: () => set({ state: "off" }),
    repair: () => set({ state: "on" }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { installer, emit: set };
}

async function pairedSocket(f: Awaited<ReturnType<typeof setup>>, scopes: string[]) {
  const paired = await f.pair(scopes);
  const issued = await f.ticket(paired.token);
  const socket = ticketSocket(f.server.remoteUrl, identity.fingerprint);
  const closed = once(socket, "close");
  cleanups.push(async () => {
    if (socket.readyState !== socket.CLOSED) socket.close();
    await closed;
  });
  await once(socket, "open");
  const ask = async (message: unknown) => {
    const reply = once(socket, "message");
    socket.send(JSON.stringify(message));
    return ServerMessage.parse(JSON.parse(String((await reply)[0])));
  };
  expect(
    await ask({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.device.id,
      ticket: issued.ticket,
    }),
  ).toMatchObject({ type: "welcome" });
  return ask;
}

test("a subscription gets this Mac's state, then each later change the Mac reports", async () => {
  const mac = fakeMac({ state: "needsApproval" });
  const f = await fixture({ lockedUse: mac.installer });
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "lockedUse.subscribe", requestId: "watch", subscriptionId: "mac" });
    expect(await client.next()).toEqual({
      type: "lockedUse.status",
      requestId: "watch",
      subscriptionId: "mac",
      status: { state: "needsApproval" },
    });
    await mac.emit({ state: "driftRepairNeeded", reason: "The plug-in was replaced" });
    expect(await client.next()).toEqual({
      type: "lockedUse.changed",
      subscriptionId: "mac",
      status: { state: "driftRepairNeeded", reason: "The plug-in was replaced" },
    });
    client.send({ type: "lockedUse.repair", requestId: "repair" });
    // The Mac's own report and the reply may arrive in either order; each arrives once.
    const replies = [await client.next(), await client.next()];
    expect(replies).toContainEqual({
      type: "lockedUse.result",
      requestId: "repair",
      ok: true,
      status: { state: "on" },
    });
    expect(replies).toContainEqual({
      type: "lockedUse.changed",
      subscriptionId: "mac",
      status: { state: "on" },
    });
    client.send({ type: "lockedUse.unsubscribe", requestId: "stop", subscriptionId: "mac" });
    expect(await client.next()).toMatchObject({ type: "lockedUse.result", requestId: "stop" });
    await mac.emit({ state: "off" });
    client.send({ type: "lockedUse.subscribe", requestId: "again", subscriptionId: "mac" });
    // No push for the stopped subscription arrives before the new snapshot.
    expect(await client.next()).toMatchObject({
      type: "lockedUse.status",
      requestId: "again",
      status: { state: "off" },
    });
  } finally {
    await f.close();
  }
});

test("a device without admin can read the state but cannot install, remove or repair", async () => {
  const mac = fakeMac();
  const f = await setup({ lockedUse: mac.installer });
  const ask = await pairedSocket(f, ["read", "operate"]);
  expect(
    await ask({ type: "lockedUse.subscribe", requestId: "watch", subscriptionId: "mac" }),
  ).toMatchObject({ type: "lockedUse.status", status: { state: "off" } });
  for (const type of ["lockedUse.install", "lockedUse.remove", "lockedUse.repair"])
    expect(await ask({ type, requestId: type })).toMatchObject({
      type: "lockedUse.result",
      requestId: type,
      ok: false,
      code: "forbidden",
    });
  expect(await mac.installer.detectStatus()).toEqual({ state: "off" });
});

test("until the native installer lands, an install is refused and the state is unchanged", async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "lockedUse.install", requestId: "install" });
    const reply = await client.next();
    expect(reply).toMatchObject({ type: "lockedUse.result", ok: false, code: "failed" });
    expect(reply).toHaveProperty("reason", expect.stringContaining("not yet implemented"));
    expect(reply).toHaveProperty(
      "status",
      process.platform === "darwin" ? { state: "needsApproval" } : { state: "off" },
    );
  } finally {
    await f.close();
  }
});

test("only an admin may turn on locked use, and only for the whole machine", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-locked-use-settings-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const settings = new SettingsService({ dataDir, io: { ...fileIO, watch: async () => () => {} } });
  cleanups.push(() => settings.close());
  const f = await setup({ settings });
  const ask = await pairedSocket(f, ["read", "operate"]);
  expect(
    await ask({
      type: "settings.set",
      requestId: "operate",
      key: "computer.lockedUse",
      value: true,
      layer: { kind: "global" },
    }),
  ).toMatchObject({ type: "settings.result", requestId: "operate", ok: false });

  const host = await f.connect();
  await host.next();
  host.send({
    type: "settings.set",
    requestId: "project",
    key: "computer.lockedUse",
    value: true,
    layer: { kind: "workspace", workspaceId: f.workspace },
  });
  expect(await host.next()).toMatchObject({
    type: "settings.result",
    requestId: "project",
    ok: false,
  });
  await expect(
    settings.set("computer.lockedUse", true, { kind: "workspace", workspace: f.workspace }),
  ).rejects.toThrow("global setting");
  expect(await settings.get("computer.lockedUse")).toMatchObject({
    value: false,
    provenance: "defaults",
  });

  host.send({
    type: "settings.set",
    requestId: "global",
    key: "computer.lockedUse",
    value: true,
    layer: { kind: "global" },
  });
  expect(await host.next()).toMatchObject({ type: "settings.result", ok: true });
  expect(await settings.get("computer.lockedUse")).toMatchObject({ value: true });
});
