import { join } from "node:path";
import { IconsReadResponse, IconsResolveResponse, type IconResult } from "@ace/protocol";
import { appIcon, runFile } from "../icons/app-icon.ts";
import { faviconPng } from "../icons/favicon-image.ts";
import { fetchFavicon } from "../icons/favicon-fetch.ts";
import { IconCache } from "../icons/icon-cache.ts";
import { rasterPng } from "../icons/icon-image.ts";
import { IconService } from "../icons/icon-service.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startIcons({ config, services, now }: ServiceContext): void {
  services.icons = new IconService({
    cache: new IconCache(join(config.dataDir, "icons")),
    // The public-web fetch: never the local network, never credentials (ADR 0002).
    site: (icon) => (icon.kind === "site" ? fetchFavicon(icon.origin) : Promise.resolve(null)),
    app: (icon) =>
      icon.kind === "app"
        ? appIcon(icon.identity, { platform: process.platform, run: runFile })
        : Promise.resolve(null),
    normalize: (bytes, icon) => (icon.kind === "site" ? faviconPng(bytes) : rasterPng(bytes)),
    now,
  });
}

/** Resolve requests one socket may have in flight; more are told to ask again later. */
const inFlight = 4;

/**
 * `icons.resolve` and `icons.read`: the site and app icons of a thread's own recorded browser and
 * computer-use steps. The daemon works out each step's site or app from the step itself; a
 * client can't make it fetch anything else.
 */
export function createIconsSession(context: SocketContext): SocketService {
  let active = 0;
  return {
    async handle(message) {
      if (message.type !== "icons.resolve" && message.type !== "icons.read") return false;
      const icons = context.options.icons;
      const readable =
        context.authorize("read") &&
        (message.type !== "icons.resolve" || context.canReadThread(message.threadId));
      if (!readable || !icons) {
        context.fail(icons ? "forbidden" : "unavailable", "Icons are not available", false, {
          requestId: message.requestId,
        });
        return true;
      }
      if (message.type === "icons.resolve") {
        const store = context.options.store;
        let results: IconResult[];
        if (active >= inFlight) results = message.itemIds.map(() => ({ state: "later" }));
        else {
          active++;
          try {
            results = await Promise.all(
              message.itemIds.map(async (itemId): Promise<IconResult> => {
                const icon = store.stepSurface(message.threadId, itemId)?.icon;
                if (!icon) return { state: "none" };
                const ref = await icons.resolve(icon);
                return ref
                  ? { state: "found", ref }
                  : ref === null
                    ? { state: "none" }
                    : { state: "later" };
              }),
            );
          } catch {
            results = message.itemIds.map(() => ({ state: "later" }));
          } finally {
            active--;
          }
        }
        if (context.connected())
          context.send(
            IconsResolveResponse.parse({
              type: "icons.resolve",
              requestId: message.requestId,
              threadId: message.threadId,
              icons: results,
            }),
          );
        return true;
      }
      const png = await icons.read(message.ref);
      if (!png) {
        context.fail("not_found", "Icon not found", false, { requestId: message.requestId });
        return true;
      }
      context.send(
        IconsReadResponse.parse({
          type: "icons.read",
          requestId: message.requestId,
          ref: message.ref,
          mimeType: "image/png",
          data: png.toString("base64"),
        }),
      );
      return true;
    },
  };
}
