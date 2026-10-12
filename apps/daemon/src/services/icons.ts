import { join } from "node:path";
import { IconsReadResponse, IconsResolveResponse } from "@ace/protocol";
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
    site: (icon) =>
      icon.kind === "site"
        ? fetchFavicon(icon, { fetch: globalThis.fetch })
        : Promise.resolve(null),
    app: (icon) =>
      icon.kind === "app"
        ? appIcon(icon.identity, { platform: process.platform, run: runFile })
        : Promise.resolve(null),
    normalize: (bytes, icon) => (icon.kind === "site" ? faviconPng(bytes) : rasterPng(bytes)),
    now,
  });
}

/** `icons.resolve` and `icons.read`: the site and app icons of browser and computer-use steps. */
export function createIconsSession(context: SocketContext): SocketService {
  return {
    async handle(message) {
      if (message.type !== "icons.resolve" && message.type !== "icons.read") return false;
      const icons = context.options.icons;
      if (!context.authorize("read") || !icons) {
        context.fail(icons ? "forbidden" : "unavailable", "Icons are not available", false, {
          requestId: message.requestId,
        });
        return true;
      }
      if (message.type === "icons.resolve") {
        const refs = await Promise.all(message.icons.map((icon) => icons.resolve(icon)));
        if (context.connected())
          context.send(
            IconsResolveResponse.parse({
              type: "icons.resolve",
              requestId: message.requestId,
              refs,
            }),
          );
        return true;
      }
      const png = icons.read(message.ref);
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
