import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { SettingsService, fileIO } from "@ace/settings";
import { ServerMessage, type LockedUseObservation, type LockedUseStatus } from "@ace/protocol";
import type { LockedUseInstaller } from "@ace/screen";
import { ticketSocket } from "./client-access.ts";
import { cleanups, identity, setup } from "./remote-test-support.ts";
import { fixture } from "./socket-test-support.ts";

/**
 * A Mac whose component the test controls. Every observation takes the next revision; install
 * and repair turn it on, remove turns it off. `hold` makes detections wait for `release`, still
 * resolving to what they read when they started.
 */
function fakeMac(initial: LockedUseStatus = { state: "off" }) {
  let revision = 0;
  let current: LockedUseObservation = { revision, status: initial };
  const listeners = new Set<(observation: LockedUseObservation) => void>();
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const observe = (status: LockedUseStatus) => (current = { revision: ++revision, status });
  const emit = (status: LockedUseStatus) => {
    const observation = observe(status);
    for (const listener of listeners) listener(observation);
    return Promise.resolve(observation);
  };
  const installer: LockedUseInstaller = {
    async detectStatus() {
      const read = current;
      if (gate) await gate;
      return read;
    },
    install: () => emit({ state: "on" }),
    remove: () => emit({ state: "off" }),
    repair: () => emit({ state: "on" }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    installer,
    emit,
    observe,
    hold() {
      gate = new Promise((resolve) => (open = resolve));
    },
    release() {
      gate = undefined;
      open?.();
    },
  };
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
      revision: 0,
      status: { state: "needsApproval" },
    });
    await mac.emit({ state: "driftRepairNeeded", reason: "The plug-in was replaced" });
    expect(await client.next()).toEqual({
      type: "lockedUse.changed",
      subscriptionId: "mac",
      revision: 1,
      status: { state: "driftRepairNeeded", reason: "The plug-in was replaced" },
    });
    client.send({ type: "lockedUse.repair", requestId: "repair" });
    // The Mac's own report and the reply may arrive in either order; each arrives once.
    const replies = [await client.next(), await client.next()];
    expect(replies).toContainEqual({
      type: "lockedUse.result",
      requestId: "repair",
      ok: true,
      revision: 2,
      status: { state: "on" },
    });
    expect(replies).toContainEqual({
      type: "lockedUse.changed",
      subscriptionId: "mac",
      revision: 2,
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
  expect((await mac.installer.detectStatus()).status).toEqual({ state: "off" });
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

test("a detection that finishes after a newer report never sends the older state", async () => {
  const mac = fakeMac({ state: "off" });
  const f = await fixture({ lockedUse: mac.installer });
  try {
    const client = await f.connect();
    await client.next();
    mac.hold();
    client.send({ type: "lockedUse.subscribe", requestId: "watch", subscriptionId: "mac" });
    // Let the daemon start its detection, which reads `off`, then the Mac reports `on`.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mac.emit({ state: "on" });
    mac.release();
    expect(await client.next()).toEqual({
      type: "lockedUse.status",
      requestId: "watch",
      subscriptionId: "mac",
      revision: 1,
      status: { state: "on" },
    });
    // The stale `off` detection is never pushed: the next message is the unsubscribe reply.
    client.send({ type: "lockedUse.unsubscribe", requestId: "stop", subscriptionId: "mac" });
    expect(await client.next()).toMatchObject({ type: "lockedUse.result", requestId: "stop" });
  } finally {
    await f.close();
  }
});

test("a change's result older than a report already pushed never comes after it", async () => {
  const mac = fakeMac({ state: "off" });
  // The repair reads `on`, then drift is found and reported before the repair call returns.
  mac.installer.repair = () => {
    const finished = mac.observe({ state: "on" });
    void mac.emit({ state: "driftRepairNeeded", reason: "Re-signed" });
    return Promise.resolve(finished);
  };
  const f = await fixture({ lockedUse: mac.installer });
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "lockedUse.subscribe", requestId: "watch", subscriptionId: "mac" });
    expect(await client.next()).toMatchObject({ type: "lockedUse.status", revision: 0 });
    client.send({ type: "lockedUse.repair", requestId: "repair" });
    const drift = { state: "driftRepairNeeded", reason: "Re-signed" };
    expect([await client.next(), await client.next()]).toEqual([
      { type: "lockedUse.changed", subscriptionId: "mac", revision: 2, status: drift },
      { type: "lockedUse.result", requestId: "repair", ok: true, revision: 2, status: drift },
    ]);
    client.send({ type: "lockedUse.unsubscribe", requestId: "stop", subscriptionId: "mac" });
    expect(await client.next()).toMatchObject({ type: "lockedUse.result", requestId: "stop" });
  } finally {
    await f.close();
  }
});

test("subscribing again with the same id replaces the subscription with a fresh snapshot", async () => {
  const mac = fakeMac({ state: "off" });
  const f = await fixture({ lockedUse: mac.installer });
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "lockedUse.subscribe", requestId: "first", subscriptionId: "mac" });
    expect(await client.next()).toMatchObject({ type: "lockedUse.status", requestId: "first" });
    client.send({ type: "lockedUse.subscribe", requestId: "renew", subscriptionId: "mac" });
    expect(await client.next()).toMatchObject({ type: "lockedUse.status", requestId: "renew" });
    // A renewal whose first reply is still pending replaces it too: the old request is cancelled.
    mac.hold();
    client.send({ type: "lockedUse.subscribe", requestId: "lost", subscriptionId: "mac" });
    client.send({ type: "lockedUse.subscribe", requestId: "retry", subscriptionId: "mac" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    mac.release();
    const replies = [await client.next(), await client.next()];
    expect(replies).toContainEqual(
      expect.objectContaining({ type: "error", code: "cancelled", requestId: "lost" }),
    );
    expect(replies).toContainEqual(
      expect.objectContaining({ type: "lockedUse.status", requestId: "retry" }),
    );
    // One subscription remains, so a change arrives once.
    await mac.emit({ state: "on" });
    expect(await client.next()).toMatchObject({ type: "lockedUse.changed", revision: 1 });
    client.send({ type: "lockedUse.unsubscribe", requestId: "stop", subscriptionId: "mac" });
    expect(await client.next()).toMatchObject({ type: "lockedUse.result", requestId: "stop" });
  } finally {
    await f.close();
  }
});

test("locked use subscriptions count toward the socket's shared limit and their own of eight", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-locked-use-limit-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const settings = new SettingsService({ dataDir, io: { ...fileIO, watch: async () => () => {} } });
  cleanups.push(() => settings.close());
  const mac = fakeMac();
  const f = await fixture({ settings, lockedUse: mac.installer });
  try {
    const client = await f.connect();
    await client.next();
    const lockedUse = async (id: string) => {
      client.send({ type: "lockedUse.subscribe", requestId: id, subscriptionId: id });
      return client.next();
    };
    for (let index = 0; index < 8; index++)
      expect(await lockedUse(`own-${index}`)).toMatchObject({ type: "lockedUse.status" });
    expect(await lockedUse("own-8")).toMatchObject({ type: "error", code: "limit" });
    for (let index = 0; index < 8; index++) {
      client.send({
        type: "lockedUse.unsubscribe",
        requestId: `stop-${index}`,
        subscriptionId: `own-${index}`,
      });
      await client.next();
    }

    for (let index = 0; index < 60; index++) {
      client.send({
        type: "settings.subscribe",
        requestId: `settings-${index}`,
        subscriptionId: `settings-${index}`,
        keys: ["computer.lockedUse"],
        scope: {},
      });
      expect(await client.next()).toMatchObject({ type: "settings.result", ok: true });
    }
    for (let index = 0; index < 4; index++)
      expect(await lockedUse(`shared-${index}`)).toMatchObject({ type: "lockedUse.status" });
    expect(await lockedUse("shared-4")).toMatchObject({ type: "error", code: "limit" });
    // Settings sees the locked use subscriptions too: the socket is full.
    client.send({
      type: "settings.subscribe",
      requestId: "settings-full",
      subscriptionId: "settings-full",
      keys: ["computer.lockedUse"],
      scope: {},
    });
    expect(await client.next()).toMatchObject({ type: "settings.result", ok: false });
  } finally {
    await f.close();
  }
});
