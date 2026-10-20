import { isAppUrl, isExternalUrl } from "../csp.ts";

/**
 * What the app window does with a top-level navigation request. Its own pages stay; a
 * `blob:` URL the page created (an attachment download) proceeds to the download handler;
 * anything else is dropped, opening externally when it is a web link.
 */
export type NavigationDecision = "allow" | "external" | "deny";

export function navigationDecision(url: string, appUrl: string): NavigationDecision {
  if (isAppUrl(url, appUrl)) return "allow";
  if (isBlobUrl(url)) return "allow";
  if (isExternalUrl(url)) return "external";
  return "deny";
}

/** A `blob:` URL always comes from the page itself; it carries no other origin's content. */
function isBlobUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "blob:";
  } catch {
    return false;
  }
}
