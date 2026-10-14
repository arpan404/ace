import type { BrowserOriginBlock } from "@ace/protocol";
import { PublicToolError } from "@ace/mcp-server/errors";
export class BrowserOriginError extends PublicToolError {
  readonly blocked: BrowserOriginBlock;
  constructor(origin: string, reason: BrowserOriginBlock["reason"], message: string) {
    super(reason);
    void message;
    this.blocked = { origin: origin.slice(0, 8192), reason };
  }
}
export interface OriginRequest {
  threadId: string;
  origin: string;
  url: string;
  human?: boolean;
  navigation?: boolean;
  signal?: AbortSignal;
}
export type OriginPolicy = (request: OriginRequest) => boolean | Promise<boolean>;
export function browserOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return url.origin;
  } catch {
    return undefined;
  }
}
function isLocalBrowserOrigin(origin: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
}
/** Every valid web origin is reachable. An embedder hook may refuse non-loopback origins. */
export async function allowedOrigin(
  threadId: string,
  raw: string,
  policy?: OriginPolicy,
  context: Pick<OriginRequest, "human" | "navigation" | "signal"> = {},
): Promise<boolean> {
  const origin = browserOrigin(raw);
  if (!origin) return false;
  if (!policy || isLocalBrowserOrigin(origin)) return true;
  return (await policy({ threadId, origin, url: raw, ...context })) === true;
}
