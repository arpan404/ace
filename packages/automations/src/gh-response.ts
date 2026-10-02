import type { GhResponse } from "./gh-process.ts";

export function parseGhResponse(chunks: readonly Uint8Array[], code: number | null): GhResponse {
  const output = Buffer.concat(chunks).toString("utf8");
  const boundary = /\r?\n\r?\n/.exec(output);
  if (!boundary || boundary.index === undefined) throw new Error("Missing gh response headers");
  const header = output.slice(0, boundary.index),
    body = output.slice(boundary.index + boundary[0].length);
  const status = Number(/^HTTP\/\S+ (\d{3})/m.exec(header)?.[1]);
  if (status !== 304 && (code !== 0 || status !== 200))
    throw new Error(`gh GET failed with status ${status}`);
  const responseEtag = /^etag:\s*(.+)$/im.exec(header)?.[1]?.trim();
  const link = /^link:\s*(.+)$/im.exec(header)?.[1];
  const url = link?.split(",").find((part) => /rel="next"/.test(part));
  const nextUrl = url ? /<([^>]+)>/.exec(url)?.[1] : undefined;
  let next: string | undefined;
  if (nextUrl) {
    const parsed = new URL(nextUrl);
    if (parsed.origin !== "https://api.github.com") throw new Error("Untrusted pagination URL");
    next = parsed.pathname.slice(1) + parsed.search;
  }
  return {
    status,
    etag: responseEtag,
    next,
    data: status === 304 ? undefined : JSON.parse(body),
  };
}
