import { publicGet, type PublicFetchOptions } from "./public-fetch.ts";

/**
 * An avatar's bytes through the public-web fetch (no local network, no credentials). Null when
 * GitHub has none or the fetch would leave the public web; undefined when it may work later.
 */
export async function fetchAvatar(
  url: string,
  options: PublicFetchOptions = {},
): Promise<Buffer | null | undefined> {
  const response = await publicGet(url, options);
  if (response.kind === "ok") return response.body;
  return response.kind === "failed" ? undefined : null;
}
