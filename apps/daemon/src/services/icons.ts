import { join } from "node:path";
import {
  AvatarsResolveResponse,
  IconsReadResponse,
  IconsResolveResponse,
  type IconRef,
  type IconResult,
} from "@ace/protocol";
import { appIcon, runFile } from "../icons/app-icon.ts";
import { fetchAvatar } from "../icons/avatar-fetch.ts";
import { githubAvatarUrl } from "../icons/avatar-url.ts";
import { faviconPng } from "../icons/favicon-image.ts";
import { fetchFavicon } from "../icons/favicon-fetch.ts";
import { IconCache } from "../icons/icon-cache.ts";
import { installedIconPng, rasterPng } from "../icons/icon-image.ts";
import { IconService } from "../icons/icon-service.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startIcons({ config, services, now }: ServiceContext): void {
  services.icons = new IconService({
    cache: new IconCache(join(config.dataDir, "icons")),
    // The public-web fetch: never the local network, never credentials (ADR 0002).
    site: (icon) => fetchFavicon(icon.origin),
    app: (icon) => appIcon(icon.identity, { platform: process.platform, run: runFile }),
    avatar: (icon) => fetchAvatar(icon.url),
    // An app's icon is installed on this machine; a Linux one may be its theme's SVG.
    normalize: (bytes, icon) =>
      icon.kind === "site"
        ? faviconPng(bytes)
        : icon.kind === "app"
          ? installedIconPng(bytes)
          : rasterPng(bytes),
    now,
  });
}

/** Resolve requests one socket may have in flight; more are told to ask again later. */
const inFlight = 4;

/** A resolution as the wire says it: found with its ref, none, or ask again later. */
function result(ref: IconRef | null | undefined): IconResult {
  return ref ? { state: "found", ref } : ref === null ? { state: "none" } : { state: "later" };
}

/** Each reported URL's GitHub avatar; a URL naming none is `none` without any fetch. */
function resolveAvatars(icons: IconService, urls: string[]): Promise<IconResult[]> {
  return Promise.all(
    urls.map(async (reported) => {
      const url = githubAvatarUrl(reported);
      return url ? result(await icons.resolve({ kind: "avatar", url })) : { state: "none" };
    }),
  );
}

/**
 * `icons.resolve`, `avatars.resolve` and `icons.read`: the site and app icons of a thread's own
 * recorded browser and computer-use steps, and people's GitHub avatars. The daemon works out each
 * step's site or app from the step itself, and each avatar from its GitHub id on GitHub's own
 * avatar host; a client can't make it fetch anything else.
 */
export function createIconsSession(context: SocketContext): SocketService {
  let active = 0;
  return {
    async handle(message) {
      if (
        message.type !== "icons.resolve" &&
        message.type !== "avatars.resolve" &&
        message.type !== "icons.read"
      )
        return false;
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
      if (message.type === "avatars.resolve") {
        let results: IconResult[];
        if (active >= inFlight) results = message.urls.map(() => ({ state: "later" }));
        else {
          active++;
          try {
            results = await resolveAvatars(icons, message.urls);
          } catch {
            results = message.urls.map(() => ({ state: "later" }));
          } finally {
            active--;
          }
        }
        if (context.connected())
          context.send(
            AvatarsResolveResponse.parse({
              type: "avatars.resolve",
              requestId: message.requestId,
              icons: results,
            }),
          );
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
                return result(await icons.resolve(icon));
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
