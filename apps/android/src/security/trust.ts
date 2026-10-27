/**
 * The only trust decision for Android pairing and paired connections.
 *
 * Mirrors the iOS `PinnedTrust` rules (`apps/ios/Sources/Host/PinnedTrust.swift`)
 * and the daemon's Node pinning (`apps/daemon/src/client-access.ts`), as ADR 0097
 * requires: the QR-confirmed SHA-256 DER SPKI pin plus the certificate's
 * validity window authenticates the daemon. One exception: a Tailscale
 * `*.ts.net` host may instead present the publicly trusted certificate
 * Tailscale issues for that exact name, whose key rotates on every renewal.
 * No other host ever falls back to system trust.
 *
 * This module decides only. It never touches the network and never hashes
 * certificates itself: the native adapter (parity task A02.02) must supply
 * `actualPin` as the lowercase hex SHA-256 of the leaf certificate's DER
 * SubjectPublicKeyInfo bytes (including its algorithm identifier), plus the
 * leaf's validity window, read from the same handshake before any credential
 * is written. Until that adapter exists, nothing here may authorize a
 * connection, and unpinned transports must never carry pairing material.
 */

export type TrustFailure = "mismatch" | "expired" | "malformed";

export class TrustError extends Error {
  readonly failure: TrustFailure;
  constructor(failure: TrustFailure) {
    super(
      failure === "mismatch"
        ? "This computer's identity doesn't match the pairing link. Do not proceed."
        : failure === "expired"
          ? "This computer's certificate is outside its validity window."
          : "This computer's certificate could not be read.",
    );
    this.name = "TrustError";
    this.failure = failure;
  }
}

export interface TrustInput {
  /** Lowercase hex SPKI digest of the leaf certificate from this handshake. */
  readonly actualPin: string;
  /** Lowercase hex pin confirmed from the pairing link. */
  readonly expectedPin: string;
  /** The host being connected, exactly as named in the pairing link. */
  readonly host: string;
  /** Current time in milliseconds since the Unix epoch. */
  readonly nowMs: number;
  /** Leaf certificate validity window in milliseconds since the Unix epoch. */
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
  /** Whether the platform trusts the presented chain for this exact host. */
  readonly systemTrusts: () => boolean;
}

/**
 * Decide whether the presented certificate authenticates the daemon.
 * Throws `TrustError` on any failure; returns normally when trusted.
 */
export function decideTrust(input: TrustInput): void {
  if (!isPin(input.actualPin) || !isPin(input.expectedPin)) throw new TrustError("malformed");
  if (
    !Number.isFinite(input.nowMs) ||
    !Number.isFinite(input.notBeforeMs) ||
    !Number.isFinite(input.notAfterMs) ||
    input.notBeforeMs > input.notAfterMs
  ) {
    throw new TrustError("malformed");
  }
  if (input.actualPin !== input.expectedPin) {
    if (isTailnetName(input.host) && input.systemTrusts()) return;
    throw new TrustError("mismatch");
  }
  if (input.nowMs < input.notBeforeMs || input.nowMs >= input.notAfterMs) {
    throw new TrustError("expired");
  }
}

/** A 64-character lowercase hex SHA-256 digest. */
export function isPin(value: string): boolean {
  if (value.length !== 64) return false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    const digit = unit >= 0x30 && unit <= 0x39;
    const hex = unit >= 0x61 && unit <= 0x66;
    if (!digit && !hex) return false;
  }
  return true;
}

/**
 * A Tailscale MagicDNS name: only the machine holding the name can get a
 * public certificate for it, so only these names qualify for the ADR 0097
 * system-trust exception.
 */
export function isTailnetName(host: string): boolean {
  let name = host.toLowerCase();
  if (name.endsWith(".")) name = name.slice(0, -1);
  return name.endsWith(".ts.net") && name.length > ".ts.net".length;
}
