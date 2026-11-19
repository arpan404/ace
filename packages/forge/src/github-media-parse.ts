import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { RenderedMedia } from "./github-media.ts";
import { marker } from "./github-media-marker.ts";

/*
 * Reads which media GitHub rendered for each requested URL (ADR 0096). Kept apart from
 * github-media.ts so parse5 loads with the first media request rather than at daemon start.
 */

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
