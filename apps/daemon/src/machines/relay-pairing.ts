import { ClientError } from "@ace/client";
import { parsePairingLink } from "@ace/client/access";
import { InstallId, PairResult, type DeviceCredential } from "@ace/protocol";
import { request } from "node:https";
import { connectClientViaRelay } from "@ace/relay";
import { pinnedAgent } from "../client-access.ts";

/**
 * Redeems another machine's relay pairing link (ADR 0070) as a device of this machine there,
 * for a fleet link that goes through that relay only (ADR 0182). One end to end encrypted
 * stream, pinned to the relay host key the link names, carries only `pair.redeem`: the same
 * single-use code, rate limit and host-chosen scopes as pairing over the TLS listener.
 * Refusals read as the direct redemption's do (`ClientError`), so the link's words are the same.
 */
export async function redeemPairingThroughRelay(
  url: string,
  name: string,
  installId: string | undefined,
  connect: typeof connectClientViaRelay = connectClientViaRelay,
): Promise<DeviceCredential & { relay: { url: string; hostId: string } }> {
  const link = parsePairingLink(url);
  if (!link.relay || !link.code) throw new ClientError("protocol", "Not a relay pairing link");
  const signal = AbortSignal.timeout(15_000);
  const channel = await connect({
    relayUrl: link.relay.url,
    hostId: link.relay.hostId,
    pinnedFingerprint: link.relay.hostId,
    signal,
  }).catch(() => {
    throw new ClientError("offline", "Couldn't reach that machine through its relay");
  });
  try {
    const install = InstallId.safeParse(installId);
    await channel.send({
      type: "pair.redeem",
      code: link.code,
      name,
      ...(install.success ? { installId: install.data } : {}),
    });
    const answer = PairResult.safeParse(await channel.receive());
    if (!answer.success) throw new ClientError("protocol", "The machine didn't answer the pairing");
    const { result } = answer.data;
    if (!result.ok) throw new ClientError("auth", result.message);
    return { device: result.device, token: result.token, relay: link.relay };
  } catch (error) {
    throw error instanceof ClientError
      ? error
      : new ClientError("offline", "The relay stream ended before the pairing was answered");
  } finally {
    channel.close();
  }
}

/**
 * Whether the machine at `origin` answers at all under its pinned key: one request that is
 * never a pairing, so asking redeems nothing. A redemption whose answer was lost may still have
 * used the code there; only a machine that doesn't answer here is tried through its relay.
 */
export function answersDirectly(origin: string, fingerprint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const agent = pinnedAgent(fingerprint);
    const done = (answered: boolean) => {
      agent.destroy();
      resolve(answered);
    };
    const asked = request(new URL("/v1/status", origin), { method: "GET", agent }, (answer) => {
      answer.resume();
      done(true);
    });
    asked.setTimeout(3_000, () => asked.destroy());
    asked.on("error", () => done(false));
    asked.end();
  });
}
