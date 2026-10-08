import { createHash } from "node:crypto";

export function deckKey(...parts: string[]): string {
  return `deck.${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}
