import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { ForgeMediaRequest, ForgeRepository } from "@ace/protocol";
import type { GhApi } from "./http.ts";

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

/** One item's marker: the request's nonce and the item's index, as a paragraph of its own. */
const marker = (nonce: string, index: number) => `ACEMEDIA${nonce}N${index}X`;

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

type Node = DefaultTreeAdapterTypes.ChildNode;
const attribute = (node: DefaultTreeAdapterTypes.Element, name: string) =>
  node.attrs.find((attr) => attr.name === name)?.value;

/** The `exp` of a signed URL's `jwt` query parameter, read without trusting it for anything else. */
function signedExpiry(url: URL): number | undefined {
  const payload = url.searchParams.get("jwt")?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp =
      typeof claims === "object" && claims !== null && "exp" in claims ? claims.exp : undefined;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function mediaAt(kind: "image" | "video", src: string | undefined): RenderedMedia {
  if (!src) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return { kind, url: url.href, expiresAt: signedExpiry(url) };
}

/**
 * The media GitHub rendered for each of `count` items in HTML produced from `mediaRenderText`:
 * the first image or video after each item's marker, or null where it rendered none.
 */
export function renderedMedia(html: string, count: number, nonce: string): RenderedMedia[] {
  const found: RenderedMedia[] = Array.from({ length: count }, () => null);
  const markers = new Map(
    Array.from({ length: count }, (_, index) => [marker(nonce, index), index]),
  );
  let current: number | undefined;
  const walk = (nodes: readonly Node[]) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      // Only a paragraph that is exactly a marker switches items; URL text never does.
      if (node.tagName === "p") {
        const only = node.childNodes.length === 1 ? node.childNodes[0] : undefined;
        const text = only?.nodeName === "#text" && "value" in only ? only.value.trim() : "";
        const index = markers.get(text);
        if (index !== undefined) {
          current = index;
          continue;
        }
      }
      if (current !== undefined && current < count && found[current] === null) {
        if (node.tagName === "img") found[current] = mediaAt("image", attribute(node, "src"));
        else if (node.tagName === "video")
          found[current] = mediaAt("video", attribute(node, "src"));
      }
      walk(node.childNodes);
    }
  };
  walk(parseFragment(html).childNodes);
  return found;
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
  return renderedMedia(html, items.length, nonce);
}
