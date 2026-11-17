import type { MarketPublisherBody } from "@ace/protocol/marketplace";
import { avatarKey, previewKey, type Context } from "./context.ts";
import { json, notFound } from "./http.ts";
import { summary } from "./rules.ts";
import type { Route } from "./routes.ts";
import { pinsOf, profileOf, publisherByHandle } from "./store/profiles.ts";
import { publisherEntries } from "./store/read.ts";

/*
 * Public profile reads (ADR 0173 §3, §6): a publisher's page, avatars and listing pictures.
 * Pictures are served as their own type, `nosniff`, immutable, under a CSP that runs nothing.
 */

const pictureHeaders = (type: string, hash: string) => ({
  "content-type": type,
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "content-disposition": "inline",
  etag: `"${hash}"`,
});

const pictureTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

async function picture(request: Request, bucket: R2Bucket, key: string, hash: string) {
  if (request.headers.get("if-none-match") === `"${hash}"`)
    return new Response(null, { status: 304, headers: { etag: `"${hash}"` } });
  const stored = await bucket.get(key);
  const type = stored?.httpMetadata?.contentType ?? "";
  if (!stored || !pictureTypes.has(type)) return notFound();
  return new Response(request.method === "HEAD" ? null : stored.body, {
    headers: { ...pictureHeaders(type, hash), "content-length": String(stored.size) },
  });
}

export async function profileRoute(
  request: Request,
  route: Route,
  context: Context,
): Promise<Response | undefined> {
  switch (route.kind) {
    case "avatar":
      return picture(request, context.env.OBJECTS, avatarKey(route.hash), route.hash);
    case "preview":
      return picture(request, context.env.OBJECTS, previewKey(route.hash), route.hash);
    case "publisher": {
      const row = await publisherByHandle(context.dbs.publishers, route.handle);
      if (!row || row.state !== "active") return notFound();
      // Listed entries only: unlisted and archived ones leave the profile (ADR 0173 §5).
      const entries = await publisherEntries(context.dbs, row.id);
      const byKey = new Map(entries.map((entry) => [`${entry.type}/${entry.name}`, entry]));
      // Pins are kept to the publisher's listed entries here, whatever moved on the way (§16).
      const pins = pinsOf(row).filter((pin) => byKey.has(`${pin.type}/${pin.name}`));
      const pinned = pins.flatMap((pin) => {
        const entry = byKey.get(`${pin.type}/${pin.name}`);
        return entry ? [summary(entry)] : [];
      });
      const body: MarketPublisherBody = {
        profile: { ...profileOf(row), pins },
        pinned,
        entries: entries.slice(0, 500).map(summary),
        downloads: entries.reduce((sum, entry) => sum + entry.downloads, 0),
      };
      return json(body, 200, { "cache-control": "public, max-age=60" });
    }
    default:
      return undefined;
  }
}
