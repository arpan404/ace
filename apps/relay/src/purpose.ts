import { z } from "zod";

/**
 * What a relayed client stream is for (ADR 0147 §5.2, docs/media/plan.md "Media connection
 * authorization"). A `/client` URL without `purpose` asks for the daemon's main or files
 * channels; `purpose=media` asks for a media stream, which the daemon hands to ace-media. The
 * relay only arranges the meeting: the daemon checks the stream's hello against the purpose.
 * Shared by the Node relay and the Cloudflare relay (`apps/cloud`).
 */
export const RelayPurpose = z.literal("media");
export type RelayPurpose = z.infer<typeof RelayPurpose>;

/** The `/host` `features` value a daemon sends when it takes media streams. */
export const MEDIA_FEATURE = "media";

/** The features a `/host` URL names, comma separated (`features=http,media`). */
export function hostFeatures(url: URL): ReadonlySet<string> {
  return new Set((url.searchParams.get("features") ?? "").split(",").filter(Boolean));
}

/**
 * The purpose a `/client` URL asks for: `undefined` for none, or `"invalid"` for one the relay
 * doesn't know, which it refuses rather than offering the daemon a stream it can't place.
 */
export function clientPurpose(url: URL): RelayPurpose | undefined | "invalid" {
  const value = url.searchParams.get("purpose");
  if (value === null) return undefined;
  const parsed = RelayPurpose.safeParse(value);
  return parsed.success ? parsed.data : "invalid";
}
