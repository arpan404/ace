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
 * Whether a device tab's request is cancelled: it goes to the machine's loopback while the
 * page it serves is not itself on a loopback host, so a public page can never reach the
 * machine's localhost (Electron runs with Local Network Access checks off). A top-level
 * navigation to loopback always goes, so an OAuth flow can come back to `localhost`. A
 * request whose top-level page is unknown is cancelled.
 */
export function blocksLoopbackRequest(request: {
  url: string;
  resourceType: string;
  /** The URL of the request's top-level frame, or undefined when unknown. */
  topUrl: string | undefined;
}): boolean {
  if (!isLoopbackUrl(request.url)) return false;
  if (request.resourceType === "mainFrame") return false;
  return !isLoopbackUrl(request.topUrl);
}
