import { TransferChunkAck, transferRelayPieceBytes } from "@ace/protocol";
import type { RemoteProfile } from "../cli/profiles.ts";
import type { MachineRoute } from "../machines/link-routes.ts";
import { MachineLink } from "../machines/machine-link.ts";
import {
  TransfersNotOffered,
  transfersNotOffered,
  type RelayLink,
  type RelayTarget,
} from "../machines/relay-link.ts";
import {
  MachineFailure,
  MachineTimeout,
  MachineUnpaired,
  type MachineTransportOptions,
  type PinnedRequest,
} from "../machines/transport.ts";
import type { TransferTransport } from "./client.ts";
import {
  hostedRelayRefusal,
  nextPiece,
  routeCarries,
  transferSend,
  type TransferSend,
} from "./route-policy.ts";

/** The routes and relay streams parcels keep to each machine, shared with transfers. */
export interface MachineLinks {
  machines: MachineLink;
  relay: Pick<RelayLink, "transfer">;
}

export interface TransferRoutesDeps {
  /** One request to a direct address: the profile's `origin` and `fingerprint` name it. */
  direct: TransferTransport;
  /** Kept-open connections, shared only on the address the machines were linked on. */
  connections?: MachineTransportOptions["connections"];
  /** The shared routes, once parcels started; without them only the linked address is tried. */
  links(): MachineLinks | undefined;
  /**
   * Whether this pairing (its device and token there) is still saved, asked before each route:
   * an unlinked or re-paired machine is sent nothing more on any of them.
   */
  current(profile: RemoteProfile): boolean;
  now(): number;
}

/**
 * Transfer requests by every route that reaches the machine (ADR 0192): the address it was
 * linked on, its other direct addresses under the same key, the person's own relay, then ace's,
 * the one that answered lately first, as parcels go. What goes over ace's hosted relay is
 * bounded (`route-policy.ts`).
 *
 * Every transfer call is idempotent under its transfer id (a chunk under its offset), so one
 * lost on a route goes on to the next. A refusal is the machine's answer and is never sent
 * elsewhere, nor is a call held back because its pairing is gone.
 */
export function routedTransfers(deps: TransferRoutesDeps): TransferTransport {
  // Before parcels start there are no shared routes: the linked address only, unpreferred.
  const alone = new MachineLink({ paths: () => [], hosted: () => false, now: deps.now });
  return async (profile, request, options) => {
    const links = deps.links();
    const machines = links?.machines ?? alone;
    const routes = links ? machines.routes(profile) : savedOnly(profile);
    const send = transferSend(request);
    const allowed = routes.filter((route) => routeCarries(route, send));
    // A bulk upload ace's relay won't carry is refused at once, unless a direct address answered
    // lately: then it is a blip, waited out as any lost link is.
    const heldBack = allowed.length < routes.length;
    const lately = machines.lastRoute(profile);
    const directLately = lately === "saved" || lately === "lan" || lately === "tailscale";
    const refuse = () =>
      heldBack && !directLately
        ? new MachineFailure("refused", "not_supported", hostedRelayRefusal, true)
        : undefined;
    try {
      const { answer } = await machines.attempt(profile, allowed, {
        send: (route) => once(deps, links, profile, route, request, send, options),
        moveOn: (error) =>
          !(error instanceof MachineUnpaired) &&
          !(error instanceof MachineFailure && error.kind === "refused"),
        none: () =>
          refuse() ??
          new MachineFailure(
            "refused",
            "not_supported",
            "That machine has no address or relay this one can reach. Link it again where its address answers.",
            true,
          ),
        signal: options.signal,
      });
      return answer;
    } catch (error) {
      if (error instanceof MachineFailure && error.kind === "refused") throw error;
      if (options.signal?.aborted) throw error;
      const refusal = refuse();
      if (refusal) throw refusal;
      // Only an older machine's relay was left: what to do is to update ace there.
      if (error instanceof TransfersNotOffered)
        throw new MachineFailure("refused", "not_supported", transfersNotOffered, true);
      throw error;
    }
  };
}

/** The address the machines were linked on, as transfers always went. */
function savedOnly(profile: RemoteProfile): MachineRoute[] {
  return profile.origin && profile.fingerprint
    ? [{ kind: "direct", url: profile.origin, fingerprint: profile.fingerprint, path: "saved" }]
    : [];
}

function once(
  deps: TransferRoutesDeps,
  links: MachineLinks | undefined,
  profile: RemoteProfile,
  route: MachineRoute,
  request: PinnedRequest,
  send: TransferSend,
  options: MachineTransportOptions,
): Promise<unknown> {
  if (!deps.current(profile))
    throw new MachineUnpaired("offline", undefined, "Transfer call never sent: unpaired");
  if (route.kind === "direct") {
    const { connections: _connections, ...rest } = options;
    return deps.direct(
      { ...profile, origin: route.url, fingerprint: route.fingerprint },
      request,
      // Only the linked address shares the machine's kept-open connections.
      route.path === "saved" && deps.connections
        ? { ...rest, connections: deps.connections }
        : rest,
    );
  }
  if (!links) throw new MachineFailure("offline");
  const target: RelayTarget = {
    url: route.url,
    relayHostId: route.relayHostId,
    hosted: route.hosted,
    deviceId: profile.deviceId,
    token: profile.token,
  };
  const timing = {
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  if (send.kind === "call")
    return links.relay.transfer(target, { kind: "call", call: send.call }, timing);
  return relayChunk(links.relay, target, send, timing, deps.now);
}

/**
 * One chunk through a relay, in pieces of at most `transferRelayPieceBytes`, each acknowledged
 * by offset within what is left of the chunk's timeout. An answer that isn't the next piece's
 * end (the target holds less, or already more) ends it: the sender goes on from that offset.
 */
async function relayChunk(
  relay: MachineLinks["relay"],
  target: RelayTarget,
  send: Extract<TransferSend, { kind: "chunk" }>,
  options: { timeoutMs: number; signal?: AbortSignal },
  now: () => number,
): Promise<{ offset: number }> {
  if (send.part !== "code" && send.part !== "ignored")
    throw new MachineFailure(
      "refused",
      "not_supported",
      "This part of a transfer can't go through a relay yet.",
      true,
    );
  const part = send.part;
  const deadline = now() + options.timeoutMs;
  const chunk = { offset: send.offset, length: send.data.length };
  let held = send.offset;
  for (;;) {
    const piece = nextPiece(chunk, held, transferRelayPieceBytes);
    if (!piece) return { offset: held };
    const left = deadline - now();
    if (left <= 0) throw new MachineTimeout("disconnected", undefined, "Chunk timed out");
    const data = send.data.subarray(
      piece.offset - send.offset,
      piece.offset - send.offset + piece.length,
    );
    const answer = TransferChunkAck.parse(
      await relay.transfer(
        target,
        {
          kind: "chunk",
          transferId: send.transferId,
          offset: piece.offset,
          part,
          data: data.toString("base64"),
        },
        { ...options, timeoutMs: left },
      ),
    );
    if (answer.offset !== piece.offset + piece.length) return answer;
    held = answer.offset;
  }
}
