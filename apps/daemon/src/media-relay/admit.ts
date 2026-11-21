import { orgRole } from "@ace/account-grant/org-roles";
import { HostId, type ServerMessage } from "@ace/protocol";
import type { MachineAccount } from "../account-access/machine-account.ts";
import type { Devices } from "../devices.ts";
import { relayHello } from "../relay-hello.ts";
import type { RemoteAuth } from "../remote-auth.ts";
import type { AdmitMediaHello, MediaGrant } from "./streams.ts";

/**
 * Who presents a media ticket: the device and how it is admitted here. A ticket opens only for
 * the device and admission kind that asked for it with `media.connect`.
 */
export type MediaClaimant = { device: string; admission: "pairing" | "account" };

/**
 * Redeems a `media.connect` ticket (D1's `MediaConnections`): once, before it expires, for its
 * own device and admission kind, while its main session is still open. The grant names the
 * connection and its owner; undefined refuses.
 */
export type MediaTicketClaim = (ticket: string, claimant: MediaClaimant) => MediaGrant | undefined;

const refused: Extract<ServerMessage, { type: "error" }> = {
  type: "error",
  code: "unauthorized",
  message: "Valid hello required",
};

/**
 * The hello on a relay media stream (docs/media/plan.md, "Media connection authorization"), in
 * order: it names the media channel with a ticket; the device's credential, as for any channel;
 * then the ticket's owner (same device and admission kind, session still open).
 */
export function mediaHelloAdmission(options: {
  auth: RemoteAuth;
  devices: Devices;
  account?: MachineAccount | undefined;
  hostId: string;
  claim: MediaTicketClaim;
}): AdmitMediaHello {
  return async (hello, signal) => {
    if (hello.channel !== "media" || hello.mediaTicket === undefined)
      return { ok: false, refusal: refused };
    const admitted = await relayHello(hello, options);
    // Given up while the credential was checked (an account grant can take a while): the
    // ticket is left unclaimed.
    if (signal.aborted) return { ok: false };
    if (!admitted.device) return { ok: false, refusal: admitted.refusal ?? refused };
    // A member who reaches only Spade opens no media channel (ADR 0206 §2.2).
    if (admitted.member && orgRole(admitted.member.role) !== "owner")
      return { ok: false, refusal: refused };
    const account = admitted.stillAdmitted !== undefined;
    if (
      !account &&
      !options.devices.current(admitted.device.id, admitted.device.generation, options.auth.now())
    )
      return { ok: false, refusal: refused };
    if (account && admitted.stillAdmitted?.() !== true) return { ok: false, refusal: refused };
    const grant = options.claim(hello.mediaTicket, {
      device: admitted.device.id,
      admission: account ? "account" : "pairing",
    });
    if (!grant) return { ok: false, refusal: refused };
    return {
      ok: true,
      grant,
      welcome: {
        type: "welcome",
        hostId: HostId.parse(options.hostId),
        protocolVersion: 1,
        headSeq: 0,
      },
    };
  };
}
