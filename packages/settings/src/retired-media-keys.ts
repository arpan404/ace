/**
 * The media pipeline settings are gone (ADR 0201): ace-media is the only encoder, deliverer,
 * recorder and image pipeline, so nothing reads these keys. A file from an older build that still
 * holds them loads as if they were absent, and they are removed on the next successful read.
 */
const retired: ReadonlySet<string> = new Set([
  "media.encode",
  "media.delivery",
  "media.recordings",
  "media.stills",
]);

export function retiredMediaKeys(settings: object): string[] {
  return Object.keys(settings).filter((key) => retired.has(key));
}
