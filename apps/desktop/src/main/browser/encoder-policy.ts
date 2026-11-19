import { encoderOrigin } from "./page-video.ts";

/*
 * What the desktop's encoder page may reach (E4): its own `app://video-encoder` files, and
 * ace-media's loopback ingest at the one port the daemon gave last, nothing else. The port
 * changes whenever ace-media starts again, so the page's content security policy is made for
 * the endpoint it was loaded with, and a page made for another endpoint is made again.
 */

/** `ws://127.0.0.1:<port>` of an ingest URL in its only allowed form, or undefined. */
export function ingestEndpoint(url: string): string | undefined {
  const match = /^ws:\/\/127\.0\.0\.1:(\d{1,5})\/ingest$/.exec(url);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return `ws://127.0.0.1:${port}`;
}

/** The page's policy: its own scripts, and a connection to `endpoint` only. */
export function encoderPolicy(endpoint: string | undefined): string {
  return `default-src 'none'; script-src 'self'; connect-src ${endpoint ?? "'none'"}`;
}

/** Whether the encoder's partition lets a request through. */
export function encoderRequestAllowed(url: string, endpoint: string | undefined): boolean {
  if (url.startsWith(`${encoderOrigin}/`)) return true;
  return endpoint !== undefined && url === `${endpoint}/ingest`;
}

/** Whether a loaded page (made for `page.endpoint`) can't reach `endpoint` and must be remade. */
export function needsNewPage(
  page: { endpoint: string | undefined } | undefined,
  endpoint: string | undefined,
): boolean {
  return page !== undefined && page.endpoint !== endpoint;
}
