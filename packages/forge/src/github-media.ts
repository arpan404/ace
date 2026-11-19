import type { ForgeMediaRequest, ForgeRepository } from "@ace/protocol";
import type { GhApi } from "./http.ts";
import { marker } from "./github-media-marker.ts";

/*
 * Media in pull request and issue text, as GitHub shows it (ADR 0096). Attachments on
 * `github.com/user-attachments/assets/<id>` need the viewer's GitHub session; GitHub's rendering
 * of the same text replaces each with a signed URL (valid for minutes) on
 * private-user-images.githubusercontent.com, and every other image with its camo proxy URL. ace
 * asks for that rendering through `gh` with only the URLs in question, then reads which media
 * GitHub produced for each. Nothing here holds a credential: the signed URL is a one-file grant
 * GitHub hands to whoever may read the text.
 */

/** What GitHub rendered for one requested URL: a fetchable media URL, or nothing. */
export type RenderedMedia = {
  kind: "image" | "video";
  url: string;
  /** When a signed URL stops working (epoch ms); undefined for URLs that don't expire. */
  expiresAt: number | undefined;
} | null;

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const attachmentPath = new RegExp(`^/user-attachments/assets/(${uuid})/?$`, "i");
const signedPath = new RegExp(`^/\\d+/\\d+-(${uuid})\\.[a-z0-9]{1,8}$`, "i");

/**
 * What a URL in the text names, as a cache key: one attachment by its asset id however it was
 * written (the upload URL, or a signed URL someone pasted), anything else by its URL without a
 * fragment. Undefined for anything that isn't an absolute http(s) URL.
 */
export function mediaKey(source: string): string | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;
  const pattern =
    url.hostname === "github.com"
      ? attachmentPath
      : url.hostname === "private-user-images.githubusercontent.com"
        ? signedPath
        : undefined;
  const asset = pattern?.exec(url.pathname)?.[1];
  if (asset) return `asset:${asset.toLowerCase()}`;
  url.hash = "";
  return `url:${url.href}`;
}

/**
 * Text that GitHub renders into one media element per item, each after its own marker: an image
 * as an `<img>`, a link alone on its line (so an uploaded video becomes a player).
 */
export function mediaRenderText(items: readonly ForgeMediaRequest[], nonce: string): string {
  return items
    .map((item, index) => {
      const url = new URL(item.url).href;
      const media = item.role === "image" ? `<img src="${url.replaceAll('"', "%22")}">` : url;
      return `${marker(nonce, index)}\n\n${media}`;
    })
    .join("\n\n");
}

/** GitHub's rendering of each item's media, in one request. */
export async function renderGitHubMedia(
  api: GhApi,
  repository: ForgeRepository,
  items: readonly ForgeMediaRequest[],
  nonce: string,
  signal: AbortSignal,
): Promise<RenderedMedia[]> {
  const html = await api.renderMarkdown(
    mediaRenderText(items, nonce),
    `${repository.owner}/${repository.name}`,
    signal,
  );
  // parse5 loads with the first media request, not at daemon start.
  const { renderedMedia } = await import("./github-media-parse.ts");
  return renderedMedia(html, items.length, nonce);
}
