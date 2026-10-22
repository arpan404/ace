import { z } from "zod";
import { ForgeRepository } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";

/*
 * Images and videos people put in pull request and issue text (ADR 0096). A client names the
 * URLs exactly as the text wrote them; the daemon asks the forge to render them, fetches the
 * bytes itself and keeps them in its own cache, so no client ever contacts the forge's media
 * hosts and no signed URL leaves the daemon. Bytes are read with the `forge.media.download`
 * file operation, by the hash a resolve returned.
 */

/** The largest media file the daemon keeps (32 MiB, the client's original-image budget). */
export const forgeMediaMaxBytes = 32 * 1024 * 1024;
/** URLs one resolve may name. */
export const forgeMediaBatch = 32;

/**
 * How the text uses a URL: `image` where it asks for an image (markdown image, `<img>`,
 * `<source srcset>`); `link` for a link alone on its line, which the forge may show as a video.
 */
export const ForgeMediaRole = z.enum(["image", "link"]);
export type ForgeMediaRole = z.infer<typeof ForgeMediaRole>;

export const ForgeMediaRequest = z.object({
  url: z.string().min(1).max(2048),
  role: ForgeMediaRole,
});
export type ForgeMediaRequest = z.infer<typeof ForgeMediaRequest>;

/** Why media can't be shown: fixed categories, never forge or network text. */
export const ForgeMediaUnavailable = z.enum([
  /** Larger than `forgeMediaMaxBytes`. */
  "too_large",
  /** Bytes that are not an image or video the page can show. */
  "unsupported",
  /** The forge rendered nothing for it, or its host has nothing there. */
  "not_found",
  /** The forge refused (signed out, no access, private repository elsewhere). */
  "forbidden",
  "offline",
  "rate_limited",
  /** Anything else; asking again later may work. */
  "failed",
]);
export type ForgeMediaUnavailable = z.infer<typeof ForgeMediaUnavailable>;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const ForgeMediaResult = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    kind: z.enum(["image", "video"]),
    /** Names the bytes for `forge.media.download`. */
    sha256,
    /** Sniffed from the bytes, never taken from a header. */
    mimeType: z.string().min(1).max(64),
    bytes: z.number().int().positive().max(forgeMediaMaxBytes),
    /** An image's pixel size from its header, when it could be read: space to reserve. */
    width: z.number().int().positive().max(65_535).optional(),
    height: z.number().int().positive().max(65_535).optional(),
  }),
  /** A `link` the forge shows as a plain link: not media. */
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("unavailable"), reason: ForgeMediaUnavailable }),
]);
export type ForgeMediaResult = z.infer<typeof ForgeMediaResult>;

export const ForgeMediaOperations = [
  z.object({
    op: z.literal("forge.media.resolve"),
    workspaceId: WorkspaceId,
    repository: ForgeRepository.optional(),
    items: z.array(ForgeMediaRequest).min(1).max(forgeMediaBatch),
  }),
  /** The forge's image-only emoji (`:octocat:`): shortcode to image URL, resolved as media. */
  z.object({
    op: z.literal("forge.emoji.images"),
    workspaceId: WorkspaceId,
    repository: ForgeRepository.optional(),
  }),
] as const;

export const ForgeMediaResults = [
  z.object({
    resource: z.literal("media"),
    /** One per requested item, in order. */
    items: z.array(ForgeMediaResult).max(forgeMediaBatch),
  }),
  z.object({
    resource: z.literal("emojiImages"),
    images: z
      .record(
        z.string().regex(/^[a-z0-9_+-]{1,64}$/),
        z
          .string()
          .max(512)
          .regex(/^https:\/\//),
      )
      .refine((images) => Object.keys(images).length <= 256),
  }),
] as const;
