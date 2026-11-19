import type { MachineTransferCall } from "@ace/protocol";
import type { PinnedRequest } from "../machines/transport.ts";
import type { MachineRoute } from "../machines/link-routes.ts";

/**
 * Which transfer calls may go by which route (ADR 0192), with no I/O. Over the person's own
 * relay, and over a direct address, everything goes. Over ace's hosted relay, which ace pays to
 * run for everyone, only control calls and small payloads do.
 */

/**
 * The most bytes of a bulk payload (the project's code, or the files Git ignores, each counted
 * on its own) that ace's hosted relay carries. A live move's final payload (ADR 0191), which
 * holds what changed since the bulk and the provider's session, always may.
 *
 * 8 MiB holds a small project or a bundle of a few commits, and takes about three minutes on a
 * 400 kbit/s link (3G). Past that, a transfer belongs on a direct address or the person's own
 * relay, where the bytes cost ace nothing and move faster.
 */
export const HOSTED_RELAY_TRANSFER_BYTES = 8 * 1024 * 1024;

/** What one transfer request asks, as the route choice reads it. */
export type TransferSend =
  | { kind: "call"; call: MachineTransferCall }
  | { kind: "chunk"; transferId: string; offset: number; part: string; data: Buffer };

/**
 * The call a request to the transfer listener carries. This machine's own `TransferClient` made
 * it, so it is read without checking again (ADR 0125).
 */
export function transferSend(request: PinnedRequest): TransferSend {
  const url = new URL(request.path, "https://ace.invalid");
  if (url.pathname === "/v1/transfers/chunk")
    return {
      kind: "chunk",
      transferId: url.searchParams.get("transfer") ?? "",
      offset: Number(url.searchParams.get("offset")),
      part: url.searchParams.get("part") ?? "code",
      data: Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body),
    };
  return { kind: "call", call: JSON.parse(String(request.body)) as MachineTransferCall };
}

/** Whether `send` may go through ace's hosted relay. */
export function hostedRelayCarries(send: TransferSend): boolean {
  if (send.kind === "call" || send.part === "final") return true;
  return send.offset + send.data.length <= HOSTED_RELAY_TRANSFER_BYTES;
}

/** Whether `send` may go by `route` at all. */
export function routeCarries(route: MachineRoute, send: TransferSend): boolean {
  return route.kind === "direct" || !route.hosted || hostedRelayCarries(send);
}

/** The words for a bulk upload ace's relay won't carry, with what to do instead. */
export const hostedRelayRefusal = `Only ace's relay reaches that machine right now, and it carries a project's files only up to ${HOSTED_RELAY_TRANSFER_BYTES / 1024 ** 2} MiB. Send it again while the machines reach each other directly (LAN or Tailscale), or link them through your own relay.`;

/**
 * Splits `[offset, offset + length)` into relay pieces of at most `pieceBytes`, from `at`:
 * the next piece's range, or undefined once nothing is left.
 */
export function nextPiece(
  chunk: { offset: number; length: number },
  at: number,
  pieceBytes: number,
): { offset: number; length: number } | undefined {
  const end = chunk.offset + chunk.length;
  if (at < chunk.offset || at >= end) return undefined;
  return { offset: at, length: Math.min(pieceBytes, end - at) };
}
