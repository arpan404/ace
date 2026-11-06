import { PairingLinkProof, type DeviceId } from "@ace/protocol";

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/**
 * Proof, for an account hello, that this install also holds the paired credential `token` of
 * device `pairedDeviceId` on that machine (ADR 0115): the base64url HMAC-SHA256 of
 * `ace-link/v1\n<paired>\n<account>`, keyed by the hex SHA-256 of the token, which is all the
 * daemon keeps of it. The token itself never leaves the pairing's own connections.
 */
export async function pairingLinkProof(
  token: string,
  pairedDeviceId: DeviceId,
  accountDeviceId: DeviceId,
  subtle: SubtleCrypto,
): Promise<PairingLinkProof> {
  const key = await subtle.importKey(
    "raw",
    encoder.encode(hex(await subtle.digest("SHA-256", encoder.encode(token)))),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await subtle.sign(
    "HMAC",
    key,
    encoder.encode(`ace-link/v1\n${pairedDeviceId}\n${accountDeviceId}`),
  );
  return PairingLinkProof.parse({ deviceId: pairedDeviceId, proof: base64url(mac) });
}
