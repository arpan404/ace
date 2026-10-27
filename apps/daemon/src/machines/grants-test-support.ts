import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DeviceId,
  HostId,
  PairingResponse,
  ThreadId,
  type FleetOutcome,
  type MachineCall,
  type MachineCapability,
  type MachineGrantLevel,
} from "@ace/protocol";
import { accessRequest, redeemPairing } from "../client-access.ts";
import { Profiles, RemoteProfile } from "../cli/profiles.ts";
import { Client } from "../socket-test-support.ts";
import { MachineFailure, machineRequest } from "./transport.ts";
import type { pairedMachines } from "./machine-test-support.ts";

type Pair = Awaited<ReturnType<typeof pairedMachines>>;
type Target = Pair["target"];

/**
 * The person in the target's own app window, signed in with its host token, setting what a
 * linked machine may do there as Settings › Fleet does (`fleet.request`).
 */
export async function fleetWindow(target: Target) {
  const client = new Client(target.daemon.url);
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("window"),
    token: readFileSync(target.daemon.tokenPath, "utf8").trim(),
  });
  if ((await client.next()).type !== "welcome") throw new Error("Not welcomed");
  let sequence = 0;
  async function request(
    operation: Extract<Parameters<Client["send"]>[0], { type: "fleet.request" }>["operation"],
  ): Promise<Extract<FleetOutcome, { kind: "grants" }>> {
    const requestId = `grants-${++sequence}`;
    client.send({ type: "fleet.request", requestId, operation });
    for (;;) {
      const message = await client.next();
      if (message.type === "error" && message.requestId === requestId)
        throw new Error(message.message);
      if (message.type !== "fleet.result" || message.requestId !== requestId) continue;
      if (message.result.kind !== "grants") throw new Error("Not a grants answer");
      return message.result;
    }
  }
  return {
    grants: () => request({ op: "grants" }),
    set: (deviceId: string, capability: MachineCapability, level: MachineGrantLevel) =>
      request({ op: "grant", deviceId: DeviceId.parse(deviceId), capability, level }),
    close: () => client.close(),
  };
}

/** The source machine's own pairing with the target, as its daemon calls it. */
export function sourceProfile(pair: Pair) {
  const profiles = new Profiles(join(pair.source.h.home, "daemon"));
  try {
    const profile = profiles.list().find((entry) => entry.name === "studio");
    if (!profile) throw new Error("Source is not paired");
    return profile;
  } finally {
    profiles.close();
  }
}

/** A second machine linked with the same target ("Build server"), as its own paired device. */
export async function secondMachine(pair: Pair): Promise<RemoteProfile> {
  const { remoteUrl, fingerprint } = pair.target.daemon;
  if (!remoteUrl || !fingerprint) throw new Error("Target is not listening");
  const pairing = PairingResponse.parse(
    await accessRequest(
      readFileSync(join(pair.target.h.home, "daemon", "daemon-endpoint"), "utf8"),
      "/v1/pairings",
      {
        method: "POST",
        token: readFileSync(pair.target.daemon.tokenPath, "utf8"),
        body: { scopes: ["read", "operate"] },
      },
    ),
  );
  const credential = await redeemPairing(pairing.url, "Build server");
  return RemoteProfile.parse({
    id: randomUUID(),
    name: "studio",
    origin: `${remoteUrl.replace("wss:", "https:").replace(/\/?$/, "/")}`,
    fingerprint,
    deviceId: credential.device.id,
    token: credential.token,
  });
}

/** One machine call as a linked machine's daemon makes it, over the target's TLS listener. */
export async function callAs(
  profile: RemoteProfile,
  call: MachineCall,
  from: { host: string; thread: string; ceiling?: "read" | "operate" } = {
    host: "build-server",
    thread: "build-thread",
  },
): Promise<{ ok: true; body: unknown } | { ok: false; code: string; message: string }> {
  try {
    const body = await machineRequest(
      profile,
      {
        origin: {
          hostId: HostId.parse(from.host),
          hostName: from.host === "build-server" ? "Build server" : from.host,
          threadId: ThreadId.parse(from.thread),
          threadTitle: "Check the release",
          ceiling: from.ceiling ?? "operate",
        },
        call,
      },
      { timeoutMs: 30_000 },
    );
    return { ok: true, body };
  } catch (error) {
    if (!(error instanceof MachineFailure)) throw error;
    return { ok: false, code: error.refusal ?? error.kind, message: error.message };
  }
}
