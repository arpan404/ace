import type { ToolIcon } from "@ace/protocol";

/*
 * A site's favicon, fetched the way any visitor could: the URL the provider reported for the
 * page, then `<origin>/favicon.ico`. Public requests only (ADR 0002): no cookies, no credentials,
 * no referrer, a short timeout and a byte cap. The fetcher is injected.
 */

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface FaviconFetchOptions {
  fetch: Fetcher;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Bytes read up to `max`; undefined when the body is larger. */
async function capped(response: Response, max: number): Promise<Buffer | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return undefined;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function candidates(icon: Extract<ToolIcon, { kind: "site" }>): string[] {
  const urls: string[] = [];
  if (icon.favicon) {
    try {
      const url = new URL(icon.favicon);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password)
        urls.push(url.href);
    } catch {
      /* A malformed reported URL leaves the origin's own favicon. */
    }
  }
  urls.push(`${icon.origin}/favicon.ico`);
  return [...new Set(urls)];
}

/**
 * The first favicon bytes the site serves. Null when it has none; undefined when every attempt
 * failed in a way that may pass (a timeout, the network), so the miss is not remembered.
 */
export async function fetchFavicon(
  icon: Extract<ToolIcon, { kind: "site" }>,
  options: FaviconFetchOptions,
): Promise<Buffer | null | undefined> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  let transient = false;
  for (const url of candidates(icon)) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await options.fetch(url, {
        signal,
        redirect: "follow",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 500 || response.status === 429) transient = true;
        continue;
      }
      const bytes = await capped(response, maxBytes);
      if (bytes?.length) return bytes;
    } catch {
      transient = true;
    }
  }
  return transient ? undefined : null;
}
