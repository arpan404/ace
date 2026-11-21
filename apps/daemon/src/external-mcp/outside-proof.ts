/*
 * ace's signature on a request it forwards to Spade for one of the person's outside agents
 * (ADR 0202 amendment 2). It binds more than the inbox's stamp does: the method, Spade's route,
 * the protocol headers Spade acts on and a nonce, so a captured request can't be replayed (Spade
 * takes each nonce once while the stamp's time verifies) or moved to another route or method.
 * Spade's `teams::proof::outside_proof` checks the same text.
 */
import { createHash, createHmac } from "node:crypto";

/** The headers Spade acts on, in the order they are signed. */
export const signedHeaders = [
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "a2a-version",
] as const;

export interface Forwarded {
  time: number;
  /** Fresh for each request: 16 to 128 URL-safe characters. */
  nonce: string;
  method: string;
  /** The path on Spade, such as `/v1/outside/mcp`. */
  route: string;
  sender: string;
  /** As sent (percent-encoded). */
  name: string;
  /** The `signedHeaders` passed on, by name; an absent one is left out. */
  headers: Partial<Record<(typeof signedHeaders)[number], string>>;
  body: Buffer;
}

/**
 * `hex(HMAC-SHA256(key, "ace-spade-outside/1\n<time>\n<nonce>\n<METHOD>\n<route>\n<sender>\n
 * <name>\n" + "<header>=<value>\n" for each header present + "<hex sha256(body)>"))`.
 */
export function outsideProof(key: string, forwarded: Forwarded): string {
  const lines = [
    "ace-spade-outside/1",
    String(forwarded.time),
    forwarded.nonce,
    forwarded.method.toUpperCase(),
    forwarded.route,
    forwarded.sender,
    forwarded.name,
  ];
  let text = `${lines.join("\n")}\n`;
  for (const header of signedHeaders) {
    const value = forwarded.headers[header];
    if (value !== undefined) text += `${header}=${value}\n`;
  }
  text += createHash("sha256").update(forwarded.body).digest("hex");
  return createHmac("sha256", key).update(text).digest("hex");
}
