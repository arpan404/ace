import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { FakeHeadless } from "@ace/browser/testing";
import {
  DeviceId,
  FleetResult,
  MachineSummary,
  type FleetOperation,
  type ServerMessage,
} from "@ace/protocol";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { Profiles } from "../cli/profiles.ts";
import { Client } from "../socket-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
}, 60_000);

const Machines = z.object({ machines: z.array(MachineSummary) });
const browser = () => ({ headlessBackend: new FakeHeadless(), ffmpeg: "/nonexistent/ffmpeg" });
type Machine = Awaited<ReturnType<typeof daemonFixture>>;

/** The machine's own app window: its socket, signed in with the host token. */
async function window(machine: Machine) {
  const client = new Client(machine.daemon.url);
  cleanup.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("window"),
    token: readFileSync(machine.daemon.tokenPath, "utf8").trim(),
  });
  const welcome = await client.next();
  if (welcome.type !== "welcome") throw new Error("Not welcomed");
  const replies: unknown[] = [];
  let requests = 0;
  async function ask(operation: FleetOperation) {
    const requestId = `fleet-${++requests}`;
    client.send({ type: "fleet.request", requestId, operation });
    for (;;) {
      const message: ServerMessage = await client.next();
      if (!("requestId" in message) || message.requestId !== requestId) continue;
      replies.push(message);
      if (message.type === "fleet.result") return FleetResult.shape.result.parse(message.result);
      if (message.type === "error") throw Object.assign(new Error(message.message), message);
    }
  }
  return { hostId: welcome.hostId, ask, replies };
}

it("one machine links another from Settings, and its agents reach that machine until unlinked", async () => {
  const studio = await daemonFixture(
    undefined,
    { browser: browser(), machines: { pollMs: 50 } },
    { ACE_LISTEN: "lan", ACE_ADVERTISE_HOST: "127.0.0.1" },
  );
  cleanup.push(() => studio.daemon.close());
  const laptop = await daemonFixture(undefined, { browser: browser(), machines: { pollMs: 50 } });
  cleanup.push(() => laptop.daemon.close());
  await studio.daemon.settings.set("host.displayName", "Studio", { kind: "global" });
  await laptop.daemon.settings.set("host.displayName", "MacBook", { kind: "global" });
  const there = await window(studio);
  const here = await window(laptop);
  const machines = async () => Machines.parse((await laptop.call({ op: "machines" })).data);

  // The studio issues the link; the laptop redeems it and keeps it.
  const pairing = await there.ask({ op: "pairing", scopes: ["read", "operate"] });
  if (pairing.kind !== "pairing") throw new Error("No pairing");
  const linked = await here.ask({
    op: "link",
    pairingUrl: pairing.url,
    hostId: there.hostId,
    name: "Studio",
  });
  // Paired, but the studio doesn't let agents from other machines in yet.
  expect(linked).toMatchObject({
    kind: "linked",
    link: { hostId: there.hostId, profile: "studio", name: "Studio", status: "refused" },
  });
  if (linked.kind !== "linked") throw new Error("Not linked");
  // The studio lists the laptop's device by the laptop's name, so it can revoke it there.
  expect(await there.ask({ op: "devices" })).toMatchObject({
    devices: expect.arrayContaining([
      expect.objectContaining({
        id: linked.link.deviceId,
        name: "MacBook",
        scopes: ["read", "operate"],
      }),
    ]),
  });

  await studio.daemon.settings.set("remote.agentAccess", "operate", { kind: "global" });
  expect(await here.ask({ op: "links" })).toEqual({
    kind: "links",
    links: [
      {
        hostId: there.hostId,
        profile: "studio",
        name: "Studio",
        origin: expect.stringMatching(/^https:\/\/127\.0\.0\.1:\d+\/$/),
        deviceId: linked.link.deviceId,
        status: "online",
        access: "operate",
        // Paired with read and operate only, so it can't take projects.
        projects: false,
      },
    ],
  });
  expect((await machines()).machines).toEqual([
    expect.objectContaining({ machine: "studio", name: "Studio", status: "online" }),
  ]);

  // No reply carries the device token the laptop now holds.
  const profiles = new Profiles(join(laptop.h.home, "daemon"));
  const [profile] = profiles.list();
  profiles.close();
  if (!profile) throw new Error("No stored link");
  expect(JSON.stringify([...here.replies, ...there.replies])).not.toContain(profile.token);

  expect(await here.ask({ op: "unlink", hostId: there.hostId })).toEqual({ kind: "unlinked" });
  expect(await here.ask({ op: "links" })).toEqual({ kind: "links", links: [] });
  expect((await machines()).machines).toEqual([]);
  await expect(here.ask({ op: "unlink", hostId: there.hostId })).rejects.toMatchObject({
    code: "not_found",
  });
});

it("linking with a used pairing link explains why and keeps no link", async () => {
  const studio = await daemonFixture(
    undefined,
    { browser: browser() },
    { ACE_LISTEN: "lan", ACE_ADVERTISE_HOST: "127.0.0.1" },
  );
  cleanup.push(() => studio.daemon.close());
  const laptop = await daemonFixture(undefined, { browser: browser() });
  cleanup.push(() => laptop.daemon.close());
  const there = await window(studio);
  const here = await window(laptop);
  const pairing = await there.ask({ op: "pairing", scopes: ["read"] });
  if (pairing.kind !== "pairing") throw new Error("No pairing");
  await there.ask({ op: "cancelPairing", id: pairing.id });
  await expect(
    here.ask({ op: "link", pairingUrl: pairing.url, hostId: there.hostId, name: "Studio" }),
  ).rejects.toMatchObject({
    code: "refused",
    message: expect.stringContaining("expired, was cancelled or was already used"),
  });
  expect(await here.ask({ op: "links" })).toEqual({ kind: "links", links: [] });
});
