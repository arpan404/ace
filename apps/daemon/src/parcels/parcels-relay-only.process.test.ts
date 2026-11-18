import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeHeadless } from "@ace/browser/testing";
import {
  DeviceId,
  FleetResult,
  ParcelId,
  ThreadId,
  type FleetOperation,
  type ServerMessage,
} from "@ace/protocol";
import { startRelay } from "@ace/relay";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { Profiles } from "../cli/profiles.ts";
import { MachineFailure } from "../machines/transport.ts";
import { selfSignedCertificate } from "../self-signed-certificate.ts";
import { Client } from "../socket-test-support.ts";
import type { ParcelLinkDeps } from "./link.ts";
import { callAs, folderOf, inputsOf, randomFile } from "./parcel-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
// The relay's TLS certificate is self-signed: what proves the machine is the relay host key
// the pairing link pins, inside the end to end encrypted stream.
const trust = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
beforeEach(() => {
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
});
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
  if (trust === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
  else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = trust;
}, 60_000);

const browser = () => ({ headlessBackend: new FakeHeadless(), ffmpeg: "/nonexistent/ffmpeg" });
const Sent = z.object({ parcelId: ParcelId });
const Delegated = z.object({ threadId: ThreadId });
const Entry = z.object({ parcelId: z.string(), state: z.string(), path: z.string().optional() });
const Listed = z.object({ received: z.array(Entry), sent: z.array(Entry) });
type Machine = Awaited<ReturnType<typeof daemonFixture>>;
// No direct path from the laptop to the studio at all: every pinned TLS call for a parcel
// fails, whatever address the studio announces, and its linked address is a closed port.
const pinned: ParcelLinkDeps["pinned"] = async () => {
  throw new MachineFailure("offline");
};

/** The machine's own app window, as Settings › Fleet uses it. */
async function window(machine: Machine) {
  const client = new Client(machine.daemon.url);
  cleanup.push(async () => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("window"),
    token: readFileSync(machine.daemon.tokenPath, "utf8").trim(),
  });
  const welcome = await client.next();
  if (welcome.type !== "welcome") throw new Error("Not welcomed");
  let requests = 0;
  async function ask(operation: FleetOperation) {
    const requestId = `fleet-${++requests}`;
    client.send({ type: "fleet.request", requestId, operation });
    for (;;) {
      const message: ServerMessage = await client.next();
      if (!("requestId" in message) || message.requestId !== requestId) continue;
      if (message.type === "fleet.result") return FleetResult.shape.result.parse(message.result);
      if (message.type === "error") throw Object.assign(new Error(message.message), message);
    }
  }
  return { hostId: welcome.hostId, ask };
}

it("machines that reach each other only through the person's relay link, delegate and exchange data through it", async () => {
  const certificate = selfSignedCertificate({ commonName: "127.0.0.1", days: 2, now: new Date() });
  const relay = await startRelay({ tls: { cert: certificate.cert, key: certificate.key } });
  cleanup.push(() => relay.close());
  if (!relay.tlsPort) throw new Error("The relay serves no TLS");
  const studio = await daemonFixture(
    undefined,
    { browser: browser(), machines: { pollMs: 50 } },
    {
      ACE_LISTEN: "lan",
      ACE_ADVERTISE_HOST: "127.0.0.1",
      ACE_RELAY_URL: `wss://127.0.0.1:${relay.tlsPort}`,
    },
  );
  cleanup.push(() => studio.daemon.close());

  const laptop = await daemonFixture(undefined, {
    browser: browser(),
    machines: { pollMs: 50 },
    parcels: { pinned, pollMs: 50 },
  });
  cleanup.push(() => laptop.daemon.close());
  await studio.daemon.settings.set("host.displayName", "Studio", { kind: "global" });
  await studio.daemon.settings.set("remote.agentAccess", "operate", { kind: "global" });
  await vi.waitFor(() => expect(studio.daemon.relayHostId).toBeTruthy(), { timeout: 15_000 });
  const there = await window(studio);
  const here = await window(laptop);

  // The studio's link names its address and its relay. From the laptop the address answers
  // nothing (a closed port stands in for a network it isn't on).
  const pairing = await there.ask({ op: "pairing", scopes: ["read", "operate"] });
  if (pairing.kind !== "pairing") throw new Error("No pairing");
  expect(pairing.url).toContain("viaRelay=");
  const unreachable = new URL(pairing.url);
  unreachable.host = "127.0.0.1:1";
  const linked = await here.ask({
    op: "link",
    pairingUrl: unreachable.toString(),
    hostId: there.hostId,
    name: "Studio",
  });
  // Linked through the relay, and described through it: the studio is online for agents.
  expect(linked).toMatchObject({ kind: "linked", link: { status: "online" } });
  const saved = new Profiles(join(laptop.h.home, "daemon"));
  const [profile] = saved.list();
  saved.close();
  expect(profile?.relay?.relayHostId).toBe(studio.daemon.relayHostId);
  expect(profile?.origin).toBe("https://127.0.0.1:1/");

  // Delegating, status polls and the parcels between parent and child all go through the relay.
  const parent = laptop.caller.threadId;
  await laptop.call({ op: "machines" });
  const child = Delegated.parse(
    (
      await laptop.call({
        op: "delegate_task",
        requestId: "relay-only-child",
        task: "Summarize the logs the parent sends",
        role: "Summarize-logs",
        provider: "claude",
        machine: profile?.name ?? "studio",
        project: "project",
      })
    ).data,
  ).threadId;
  const toChild = Sent.parse(
    (
      await laptop.call({
        op: "data.send",
        to: child,
        text: "Only the last hour matters.",
        name: "scope.txt",
      })
    ).data,
  );
  await vi.waitFor(
    async () => {
      const listed = Listed.parse((await callAs(studio, child, { op: "data.receive" })).data);
      const entry = listed.received.find((one) => one.parcelId === toChild.parcelId);
      expect(entry?.state).toBe("received");
      expect(readFileSync(entry?.path ?? "", "utf8")).toBe("Only the last hour matters.");
    },
    { timeout: 30_000 },
  );

  const file = randomFile(await folderOf(studio, child), "summary.bin", 300 * 1024);
  await vi.waitFor(
    () => expect(inputsOf(studio, child)).toContain("Summarize the logs the parent sends"),
    { timeout: 15_000 },
  );
  const toParent = Sent.parse(
    (await callAs(studio, child, { op: "data.send", to: "parent", path: "summary.bin" })).data,
  );
  // Collected through the relay; its notice waits behind the parent's running turn.
  await vi.waitFor(
    async () => {
      const listed = Listed.parse((await callAs(laptop, parent, { op: "data.receive" })).data);
      const entry = listed.received.find((one) => one.parcelId === toParent.parcelId);
      expect(entry?.state).toBe("received");
      expect(readFileSync(entry?.path ?? "").equals(file.data)).toBe(true);
    },
    { timeout: 30_000 },
  );
});
