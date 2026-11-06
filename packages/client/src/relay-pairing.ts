import { InstallId, PairResult, type DeviceCredential, type PairRefusal } from "@ace/protocol";
import { ephemeralRelayKeys } from "./device-route.ts";
import { parsePairingLink } from "./pairing-link.ts";
import type { PortableRelayOptions, PortableSocket } from "./portable-relay.ts";

/** A relayed redemption the daemon refused: wrong, used or expired code, or rate limited. */
export class RelayPairingError extends Error {
  readonly reason: PairRefusal;
  constructor(reason: PairRefusal, message: string) {
    super(message);
    this.name = "RelayPairingError";
    this.reason = reason;
  }
}

/**
 * Redeem a relay pairing link (`parsePairingLink(link).relay`) through its self-hosted relay
 * (ADR 0070): one channel, pinned to the host key in the link, carrying only `pair.redeem`. The
 * daemon answers once and closes. Returns the device and its token, and the route to keep for
 * connecting (`relayRoute` with the same relay URL and host id). Throws `RelayPairingError`
 * when refused. ace's hosted relay admits account devices only, so it never carries this.
 */
export async function redeemPairingViaRelay(input: {
  link: string;
  name: string;
  /** This app install (ADR 0115): pairing it again keeps its one device. */
  installId?: string | undefined;
  socket(url: string, protocols?: string[]): PortableSocket;
  schedule(callback: () => void, delayMs: number): () => void;
  keys?: PortableRelayOptions["keys"];
  signal?: AbortSignal;
}): Promise<DeviceCredential & { relay: { url: string; hostId: string } }> {
  const link = parsePairingLink(input.link);
  if (!link.relay) throw new Error("This pairing link doesn't go through a relay.");
  if (!link.code) throw new Error("This pairing link has no code.");
  const { connectPortableRelay } = await import("./portable-relay.ts");
  const relay = await connectPortableRelay({
    relayUrl: link.relay.url,
    pinnedFingerprint: link.relay.hostId,
    socket: input.socket,
    keys: input.keys ?? ephemeralRelayKeys,
    schedule: input.schedule,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  try {
    await relay.send({
      type: "pair.redeem",
      code: link.code,
      name: input.name,
      ...(input.installId ? { installId: InstallId.parse(input.installId) } : {}),
    });
    const answer = await relay.receive();
    const parsed = PairResult.safeParse(answer);
    if (!parsed.success) throw new Error("The computer didn't answer the pairing request.");
    const { result } = parsed.data;
    if (!result.ok) throw new RelayPairingError(result.error, result.message);
    return { device: result.device, token: result.token, relay: link.relay };
  } finally {
    relay.close();
  }
}
