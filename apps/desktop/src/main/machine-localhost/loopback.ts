import { loopbackNavigationAllowed } from "@ace/ui-core/loopback-navigation";
import { isMachineLoopbackHost } from "@ace/ui-core/machine-loopback";

export { isMachineLoopbackHost };

/*
 * Which of a device tab's requests may reach the machine's localhost (ADR 0194). Pure.
 */

/** A URL's host is the machine's loopback; false for anything that doesn't parse. */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!/^(https?|wss?):$/.test(parsed.protocol)) return false;
    return isMachineLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a device tab's request is cancelled, so a public page never reaches the machine's
 * localhost (Electron runs with Local Network Access checks off). Only requests to loopback are
 * judged; Electron asks again for each redirect, with the method that hop sends.
 *
 * - A top-level navigation follows `loopbackNavigationAllowed`, the rule the phone keeps too: the
 *   person's own, a loopback page's, or any GET (a link, or an OAuth provider's redirect back to
 *   `localhost`) goes; a public page's form post, or a 307 or 308 that keeps it, doesn't.
 * - Anything else needs a loopback initiator: the origin of the document or worker that sent it,
 *   which Chromium checks against the frame itself. A public frame inside a localhost page is
 *   refused, while a localhost page's own service worker, which has no frame, still works.
 *   A request with no initiator, or an opaque one, is refused.
 */
export function blocksLoopbackRequest(request: {
  url: string;
  resourceType: string;
  method: string;
  /** Electron's `initiatorOrigin`: undefined for a request the browser started itself. */
  initiator: string | undefined;
}): boolean {
  if (!isLoopbackUrl(request.url)) return false;
  const initiatorIsLoopback = isLoopbackUrl(request.initiator);
  if (request.resourceType === "mainFrame")
    return !loopbackNavigationAllowed({
      method: request.method,
      initiatorIsLoopback,
      byPerson: request.initiator === undefined,
    });
  return !initiatorIsLoopback;
}
