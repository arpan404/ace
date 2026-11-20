import { ClientCloseCause } from "@ace/protocol";

/**
 * A native socket's close reason that names its cause, `relay:<cause>` (the iPhone's relay
 * socket), read as the cause the next hello reports. Anything else is `other`: a close reason
 * is never reported as text. Pure.
 */
export function closeCause(reason: string): ClientCloseCause {
  if (!reason.startsWith("relay:")) return "other";
  const named = ClientCloseCause.safeParse(reason.slice("relay:".length));
  return named.success ? named.data : "other";
}
