import type { ClientMessage } from "@ace/protocol";

/** Messages the client owns: the handshake, durable commands and stream subscriptions. */
const reserved = new Set<string>(["hello", "command", "subscribe", "unsubscribe"]);

/** A one-way service control (browser frame ACK, terminal credit) that expects no reply. */
export type OneWayMessage = Exclude<
  ClientMessage,
  { type: "hello" | "command" | "subscribe" | "unsubscribe" }
>;

export function isOneWayMessage(message: ClientMessage): message is OneWayMessage {
  return !reserved.has(message.type);
}
