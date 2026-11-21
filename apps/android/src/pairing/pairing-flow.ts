import { DeviceCredential, HostIdentity, PairingRedemption } from "@ace/protocol";
import type { MachineTarget, PairedMachine } from "@ace/client/machines";
import { isPin } from "../security/trust.ts";
import {
  accessSummary,
  fingerprintGroups,
  parseAndroidPairingLink,
  type AndroidPairingLink,
} from "./pairing-link.ts";

/**
 * Paste-link confirmation and single redemption for Android production pairing.
 *
 * Aligned with the iOS `PairingView`/`ConfirmPairingView` and
 * `MachinesModel.pair` flow: the person confirms the host, its grant and its
 * fingerprint before anything is sent; the code redeems exactly once; the
 * authenticated host identity obtained on the pinned connection binds the
 * entry, never the hostname from the link.
 *
 * Transport is injected because the native pinned HTTPS adapter is later work
 * (parity task A02.02). The injected `redeem` MUST POST `{ code, name }` to
 * `origin/v1/pair` over the pinned transport with the response bounded at
 * 1 MiB, and MUST refuse unpinned, redirected or expired-identity responses
 * before credentials leave. It MUST validate `fingerprint` with `isPin` and
 * pin the TLS handshake to it (plus the validity window, as `decideTrust`
 * does) before the code is written to the request. The injected
 * `readIdentity` MUST return the `host.identity` result read on the pinned,
 * ticket-authenticated connection, pinned to the same `fingerprint`.
 * This flow validates the pin itself before calling the transport, so the
 * code is never sent without pin validation. Until those adapters exist
 * this flow must not be wired to production; the production entry point
 * stays unpaired and fail-closed.
 *
 * This module performs no networking and stores nothing itself. Callers
 * persist the returned `PairedMachine` through `MachineDirectory.add`, which
 * owns duplicate/ordering rules, and the token through the credential store.
 */

export type PairingFailure =
  | "invalid-link"
  | "invalid-name"
  | "offline"
  | "auth"
  | "expired"
  | "limit"
  | "consumed"
  | "daemon";

export class PairingFlowError extends Error {
  readonly failure: PairingFailure;
  constructor(failure: PairingFailure, message: string) {
    super(message);
    this.name = "PairingFlowError";
    this.failure = failure;
  }
}

export interface ConfirmedPairing {
  readonly link: AndroidPairingLink;
  /** Host (and port) shown for confirmation. Never an identity proof. */
  readonly displayHost: string;
  readonly accessSummary: string;
  readonly fingerprintGroups: string;
}

export interface PairingTransport {
  redeem(input: {
    origin: string;
    /** Lowercase 64-hex SPKI pin from the confirmed link; pin before sending. */
    fingerprint: string;
    code: string;
    name: string;
    signal?: AbortSignal | undefined;
  }): Promise<unknown>;
  readIdentity(input: {
    origin: string;
    /** Lowercase 64-hex SPKI pin from the confirmed link; pin before sending. */
    fingerprint: string;
    signal?: AbortSignal | undefined;
  }): Promise<unknown>;
}

/**
 * Parse and validate pasted or scanned text for the confirm screen.
 * Throws `PairingFlowError` with `invalid-link` and an actionable message.
 */
export function preparePairing(text: string): ConfirmedPairing {
  let link: AndroidPairingLink;
  try {
    link = parseAndroidPairingLink(text);
  } catch (error) {
    throw new PairingFlowError(
      "invalid-link",
      error instanceof Error ? error.message : "That isn't an ace pairing link.",
    );
  }
  return {
    link,
    displayHost: link.displayHost,
    accessSummary: accessSummary(link.scopes),
    fingerprintGroups: fingerprintGroups(link.fingerprint),
  };
}

/**
 * Redeem a confirmed link exactly once and bind the authenticated host
 * identity. `deviceName` is this phone's display name. Throws
 * `PairingFlowError`; refusal text from the daemon is preserved (sliced to
 * 512 characters) with the code, pin and token-shaped secrets redacted, never
 * sent back to the daemon.
 *
 * The pairing code is single-use: once `redeem` succeeds the daemon has
 * burned the code and minted a device, so every later failure (unreadable
 * credential, unreadable identity, aborted identity read) throws `consumed`
 * with guidance to check the computer's devices and create a new link,
 * instead of a retryable error that implies the link is still valid.
 */
export async function redeemConfirmedPairing(
  confirmed: ConfirmedPairing,
  deviceName: string,
  transport: PairingTransport,
  signal?: AbortSignal,
): Promise<PairedMachine> {
  const fingerprint = confirmed.link.fingerprint;
  if (!isPin(fingerprint)) {
    throw new PairingFlowError(
      "invalid-link",
      "This link has no valid computer fingerprint, so it can't be verified.",
    );
  }
  const name = deviceName.trim();
  let redemption: { code: string; name: string };
  try {
    redemption = PairingRedemption.parse({ code: confirmed.link.code, name });
  } catch {
    throw new PairingFlowError(
      "invalid-name",
      "Name this phone with 1 to 256 characters before pairing.",
    );
  }
  const secrets = [redemption.code, fingerprint];
  let rawCredential: unknown;
  try {
    rawCredential = await transport.redeem({
      origin: confirmed.link.daemonOrigin,
      fingerprint,
      code: redemption.code,
      name: redemption.name,
      signal,
    });
  } catch (error) {
    throw mapTransportFailure(error, secrets);
  }
  const credential = DeviceCredential.safeParse(rawCredential);
  if (!credential.success)
    throw new PairingFlowError(
      "consumed",
      "Pairing used this link but the computer's reply could not be read. " +
        "Check the computer's devices for an unused entry and remove it, then create a new link.",
    );
  let rawIdentity: unknown;
  try {
    rawIdentity = await transport.readIdentity({
      origin: confirmed.link.daemonOrigin,
      fingerprint,
      signal,
    });
  } catch (error) {
    throw toConsumed(mapTransportFailure(error, secrets));
  }
  const identity = HostIdentity.safeParse(rawIdentity);
  if (!identity.success) {
    throw new PairingFlowError(
      "consumed",
      "Pairing used this link but the computer's identity could not be read. " +
        "Check the computer's devices for an unused entry and remove it, then create a new link.",
    );
  }
  const target: MachineTarget = {
    kind: "direct",
    url: confirmed.link.socketUrl,
    fingerprint: confirmed.link.fingerprint,
  };
  return {
    identity: identity.data,
    target,
    deviceId: credential.data.device.id,
    token: credential.data.token,
  };
}

function mapTransportFailure(error: unknown, secrets: readonly string[] = []): PairingFlowError {
  if (error instanceof PairingFlowError) return error;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (code === "offline" || code === "timeout" || code === "aborted") {
      return new PairingFlowError(
        "offline",
        "This computer didn't respond. Check the connection and try again.",
      );
    }
    if (code === "auth") {
      const detail = daemonDetail(error.message, secrets);
      return new PairingFlowError(
        "auth",
        detail === undefined
          ? "This pairing link is invalid or already used. Create a new link on your computer."
          : `Pairing refused: ${detail}`,
      );
    }
    if (code === "limit") {
      return new PairingFlowError("limit", "Too many attempts. Wait a minute and try again.");
    }
    if (code === "protocol" || code === "daemon") {
      const detail = daemonDetail(error.message, secrets);
      return new PairingFlowError(
        "daemon",
        detail === undefined ? "Pairing failed. Try again." : `Pairing failed: ${detail}`,
      );
    }
  }
  return new PairingFlowError("daemon", "Pairing failed. Try again.");
}

/**
 * The code is already burned once `redeem` succeeded: surface the underlying
 * outcome as `consumed` so the person checks the computer's devices instead
 * of retrying a dead link. Refusal text is preserved without secrets.
 */
function toConsumed(error: PairingFlowError): PairingFlowError {
  if (error.failure === "consumed") return error;
  return new PairingFlowError(
    "consumed",
    "Pairing used this link but did not finish. " +
      `${error.message} Check the computer's devices for an unused entry and remove it, then create a new link.`,
  );
}

/**
 * Keep the daemon's actionable refusal text; drop anything that is not such
 * text and redact the pairing code, the pin and any token-shaped secret so a
 * daemon or proxy that echoes request material cannot leak it into errors.
 */
function daemonDetail(message: string, secrets: readonly string[] = []): string | undefined {
  const marker = ": ";
  const index = message.indexOf(marker);
  if (index < 0) return undefined;
  let detail = message.slice(index + marker.length).slice(0, 512);
  detail = scrubSecrets(detail, secrets);
  return detail === "" ? undefined : detail;
}

/** Redact exact secrets and any 32+ hex run (token-shaped) from daemon text. */
function scrubSecrets(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret !== "") scrubbed = scrubbed.split(secret).join("[redacted]");
  }
  return scrubbed.replace(/[0-9a-fA-F]{32,}/g, "[redacted]");
}
