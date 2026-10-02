export interface OriginRequest {
  threadId: string;
  origin: string;
  url: string;
  signal?: AbortSignal;
}
export type OriginPolicy = (request: OriginRequest) => boolean | Promise<boolean>;

export async function allowedOrigin(
  threadId: string,
  raw: string,
  policy?: OriginPolicy,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password)
    return false;
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return true;
  return (await policy?.({ threadId, origin: url.origin, url: raw })) === true;
}
