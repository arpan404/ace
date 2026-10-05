import type { BrowserOriginBlock, PermissionMode } from "@ace/protocol";
export class BrowserOriginError extends Error {
  readonly blocked: BrowserOriginBlock;
  constructor(origin: string, reason: BrowserOriginBlock["reason"], message: string) {
    super(message);
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
export function isLocalBrowserOrigin(origin: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
}
/** Pure consent decision. The host supplies resolved mode and grant facts. */
export function originAccess(request: {
  origin: string;
  human: boolean;
  navigation: boolean;
  mode: PermissionMode;
  granted: boolean;
}): "allow" | "human_grant" | "page_grant" | "read_only" | "review" | "block" {
  if (request.human) return request.navigation ? "human_grant" : "allow";
  if (request.navigation && request.mode === "read-only") return "read_only";
  if (isLocalBrowserOrigin(request.origin) || request.granted) return "allow";
  if (request.mode === "full-access") return request.navigation ? "page_grant" : "allow";
  return request.navigation ? "review" : "block";
}
export async function allowedOrigin(
  threadId: string,
  raw: string,
  policy?: OriginPolicy,
  context: Pick<OriginRequest, "human" | "navigation" | "signal"> & {
    manageLoopback?: boolean;
  } = {},
): Promise<boolean> {
  const origin = browserOrigin(raw);
  if (!origin) return false;
  const local = isLocalBrowserOrigin(origin);
  if (local && !context.manageLoopback) return true;
  if (policy) return (await policy({ threadId, origin, url: raw, ...context })) === true;
  return local;
}
