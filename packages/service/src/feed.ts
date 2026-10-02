import { z } from "zod";
import { verifyManifest } from "./artifact.ts";
const secureUrl = z.url().refine((s) => {
  const u = new URL(s);
  return u.protocol === "https:" && !u.username && !u.password;
});
const Feed = z.object({
  draft: z.literal(false),
  prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string().max(160), browser_download_url: secureUrl })).max(64),
});
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export async function boundedText(response: Response, cap: number): Promise<string> {
  if (!response.ok || !response.body) throw new Error("Release feed failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > cap) throw new Error("Release response too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function checkRelease(
  fetcher: Fetcher,
  feedUrl: string,
  target: string,
  channel: "stable" | "preview",
  publicKey: string,
) {
  secureUrl.parse(feedUrl);
  const get = (url: string) =>
    fetcher(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
      headers: { Accept: "application/vnd.github+json" },
    });
  const feed = Feed.parse(JSON.parse(await boundedText(await get(feedUrl), 128 * 1024)));
  if (feed.prerelease !== (channel === "preview")) throw new Error("Release channel mismatch");
  const asset = (name: string) => {
    const a = feed.assets.find((candidate) => candidate.name === name);
    if (!a) throw new Error(`Missing release asset ${name}`);
    return a.browser_download_url;
  };
  const bytes = Buffer.from(await boundedText(await get(asset(`${target}.json`)), 16 * 1024));
  const signature = (await boundedText(await get(asset(`${target}.sig`)), 128)).trim();
  const manifest = verifyManifest(bytes, signature, publicKey);
  if (manifest.target !== target || manifest.channel !== channel)
    throw new Error("Signed release target/channel mismatch");
  return { manifest, bytes, signature, url: asset(manifest.archive) };
}
/** Every redirect is checked before requesting it, including asset CDN redirects. */
export const releaseFetch: Fetcher = async (initial, init = {}) => {
  let url = secureUrl.parse(initial);
  const signal = init.signal ?? AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { ...init, redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Release redirect has no location");
    url = secureUrl.parse(new URL(location, url).toString());
  }
  throw new Error("Too many release redirects");
};
