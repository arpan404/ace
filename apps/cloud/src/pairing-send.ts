/**
 * The sends that pair a waiting client with its daemon (ADR 0155): the readiness marker to the
 * client, then the held early frame, if there is one, to the daemon. The held frame is
 * first-flight material: it is zero-filled when this returns, whether the sends went or threw.
 * `send` copies the bytes into the outgoing message, so wiping after it is safe.
 */
export function sendPairing(
  client: { send(bytes: Uint8Array): void },
  host: { send(bytes: Uint8Array): void },
  marker: number,
  held: Uint8Array | undefined,
): "forwarded" | "none" {
  try {
    client.send(new Uint8Array([marker]));
    if (!held) return "none";
    host.send(held);
    return "forwarded";
  } finally {
    held?.fill(0);
  }
}
