import { PairingFlowError, preparePairing, type ConfirmedPairing } from "./pairing-flow.ts";

/**
 * Pure view-model for the Android pairing screen (`../Pairing.tsx`).
 *
 * Mirrors the iOS `PairingView`/`ConfirmPairingView` separation
 * (`apps/ios/Sources/Views/Pairing/PairingView.swift`): pasted or scanned
 * text is only parsed into a confirmation the person checks (address, grant,
 * fingerprint); the one-use code is redeemed exactly once, on the explicit
 * Pair action, over the pinned transport. Nothing here performs networking,
 * stores anything, or logs the link: entry errors are the link parser's
 * static actionable messages, which never contain link material.
 *
 * QR capture (`./qr-scan.ts` session plus `./QrScanner.tsx` sheet, mirroring
 * the iOS `QRScannerView`) feeds the same `acceptPairingText` path as pasted
 * text: a decoded QR string is just another link candidate, so there is no
 * second redemption path and a malformed QR cannot send anything.
 */

/** Shown while the native pairing wiring is missing; pairing stays disabled. */
export const PAIRING_UNAVAILABLE_MESSAGE =
  "This build cannot pair yet. Production pairing arrives with production startup, so nothing was sent.";

/** Shown when camera capture itself fails; never echoes the scanned text. */
export const SCAN_FAILED_MESSAGE = "Scanning didn't return a link. Paste the pairing link instead.";

/** Fallback for unexpected pairing failures; never echoes raw error text. */
export const PAIRING_FAILED_MESSAGE = "Pairing failed. Try again.";

export type AcceptedPairing =
  | { readonly ok: true; readonly confirmed: ConfirmedPairing }
  | { readonly ok: false; readonly entryError: string };

/**
 * Parse pasted or scanned text for the confirm screen. Returns the
 * confirmation the person must check before anything is sent, or the
 * actionable entry error to show. Never throws and never includes the link,
 * code or pin in the error.
 */
export function acceptPairingText(text: string): AcceptedPairing {
  try {
    return { ok: true, confirmed: preparePairing(text) };
  } catch (error) {
    return {
      ok: false,
      entryError: error instanceof Error ? error.message : "That isn't an ace pairing link.",
    };
  }
}

/** The Pair action runs only with a non-blank device name and no pair in flight. */
export function canStartPairing(deviceName: string, pairing: boolean): boolean {
  return !pairing && deviceName.trim() !== "";
}

/**
 * Message to show for a pairing failure. `PairingFlowError` text is static
 * copy with daemon refusals scrubbed of the code, pin and token-shaped
 * secrets (`pairing-flow.ts`), so it is safe to display. Anything else —
 * a scanner rejection, a native bridge error, a daemon echo — may carry
 * link material, so it is never shown: the static fallback is used instead.
 * Mirrors iOS, where the confirm screen shows only the mapped
 * `pairingProblem` copy and never raw transport text.
 */
export function pairingFailureMessage(error: unknown): string {
  if (error instanceof PairingFlowError) return error.message;
  return PAIRING_FAILED_MESSAGE;
}
