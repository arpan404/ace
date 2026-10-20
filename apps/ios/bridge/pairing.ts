import type { MachineDirectory, MachineEntry } from "@ace/client/machines";
import type { DeviceScope, HostIdentity } from "@ace/protocol";
import { z } from "zod";
import {
  pairingProblem,
  redeemPairing,
  type PinnedHttp,
  type Problem,
  TrustMonitor,
} from "./access.ts";

const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
/** Swift parsed and confirmed the link; the fragment never reaches a request URL. */
export const AccessRequest = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("list") }),
  z.strictObject({ op: z.literal("remove"), hostId: z.string().min(1).max(256) }),
  z.strictObject({
    op: z.literal("rename"),
    hostId: z.string().min(1).max(256),
    name: z.string().trim().min(1).max(256),
  }),
  z.strictObject({
    op: z.literal("pair"),
    code: z.string().min(1).max(256),
    name: z.string().trim().min(1).max(256),
    url: z.string().max(4096),
    fingerprint: Fingerprint,
  }),
]);
export type AccessRequest = z.infer<typeof AccessRequest>;

export type AccessResult =
  | {
      ok: true;
      machines: readonly MachineEntry[];
      paired?: { hostId: string; scopes: DeviceScope[] };
    }
  | { ok: false; problem: Problem };

export interface PairingDeps {
  http: PinnedHttp;
  directory: MachineDirectory;
  /** Authenticated identity read over the pinned socket with the new device credential. */
  identity(deviceId: string, token: string, trust: TrustMonitor): Promise<HostIdentity>;
}

/**
 * Redeem, then read the host identity on the pinned connection, then store: the token goes to
 * the Keychain-backed secret store and only non-secret metadata reaches the directory file.
 */
export async function performAccess(deps: PairingDeps, raw: unknown): Promise<AccessResult> {
  const trust = new TrustMonitor();
  try {
    const request = AccessRequest.parse(raw);
    if (request.op === "list") return { ok: true, machines: await deps.directory.load() };
    if (request.op === "rename") {
      await deps.directory.load();
      const entry = deps.directory.machines.find((machine) => machine.hostId === request.hostId);
      await deps.directory.rename(request.hostId, request.name, entry?.icon);
      return { ok: true, machines: deps.directory.machines };
    }
    if (request.op === "remove") {
      await deps.directory.remove(request.hostId);
      return { ok: true, machines: deps.directory.machines };
    }
    const credential = await redeemPairing(deps.http, request.code, request.name, trust);
    const identity = await deps.identity(credential.device.id, credential.token, trust);
    const entry = await deps.directory.add({
      identity,
      target: { kind: "direct", url: request.url, fingerprint: request.fingerprint },
      deviceId: credential.device.id,
      token: credential.token,
    });
    return {
      ok: true,
      machines: deps.directory.machines,
      paired: { hostId: entry.hostId, scopes: credential.device.scopes },
    };
  } catch (error) {
    return { ok: false, problem: pairingProblem(error, trust) };
  }
}
