import type { AddressedTo } from "@ace/protocol";

/*
 * What ace's line says of each addressee (ADR 0194), in words: who is working, who waits for
 * the person, what came back. Pure.
 */

export function addresseeName(to: AddressedTo["to"]): string {
  return to.kind === "agent" ? to.title || "that thread" : to.name;
}

export function stateWords(entry: AddressedTo): string {
  const name = addresseeName(entry.to);
  const detail = entry.detail ? ` · ${entry.detail}` : "";
  switch (entry.state) {
    case "sending":
      return entry.to.kind === "agent" ? `Sending to ${name}` : `Asking ${name}`;
    case "queued":
      return `${name} gets it when Spade is back`;
    case "answering":
      return `${name} is working${detail}`;
    case "waiting":
      return `${name} is waiting for you`;
    case "answered":
      return `${name} answered`;
    case "stopped":
      return `${name} stopped${detail}`;
    case "failed":
      return `${name} couldn't answer${detail}`;
    case "sent":
      return `Sent to ${name}`;
  }
}
