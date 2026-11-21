import type { MachineDirectory, MachineEntry } from "@ace/client/machines";
import { InstallId, MachinePath, type DeviceScope, type HostIdentity } from "@ace/protocol";
import { z } from "zod";
import { pairingProblem, redeemedCredential, type Problem, TrustMonitor } from "./access.ts";

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
  /**
   * Swift parsed and confirmed the link and redeemed it itself, with the code and the public
   * half of the Secure Enclave key it made for this pairing (ADR 0190 §7): the script never
   * holds the code nor chooses the key. `redeemed` is the machine's answer, or why the pinned
   * transport refused it.
   */
  z.strictObject({
    op: z.literal("pair"),
    url: z.string().max(4096),
    fingerprint: Fingerprint,
    /** This app install (ADR 0115): pairing it again keeps its one device on that machine. */
    installId: InstallId.optional(),
    redeemed: z.union([
      z.strictObject({ status: z.number().int().min(100).max(599), body: z.string().max(65_536) }),
      z.strictObject({ refused: z.string().max(64) }),
    ]),
  }),
  /** What a paired machine said about its paths over its own authenticated connection. */
  z.strictObject({
    op: z.literal("remember"),
    hostId: z.string().min(1).max(256),
    paths: z.array(MachinePath).max(16),
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
  directory: MachineDirectory;
  /** Authenticated identity read over the pinned socket with the new device credential. */
  identity(
    deviceId: string,
    token: string,
    trust: TrustMonitor,
    installId?: InstallId,
  ): Promise<HostIdentity>;
}

/**
 * Take the device Swift's redemption made, then read the host identity on the pinned connection, then store: the token goes to
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
    if (request.op === "remember") {
      await deps.directory.remember(request.hostId, { paths: request.paths });
      return { ok: true, machines: deps.directory.machines };
    }
    if (request.op === "remove") {
      await deps.directory.remove(request.hostId);
      return { ok: true, machines: deps.directory.machines };
    }
    const credential = redeemedCredential(request.redeemed, trust);
    const identity = await deps.identity(
      credential.device.id,
      credential.token,
      trust,
      request.installId,
    );
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
