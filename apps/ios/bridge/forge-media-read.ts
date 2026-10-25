import type { FileDownloadInput } from "@ace/client";
import {
  ForgeRepository,
  WorkspaceId,
  forgeMediaMaxBytes,
  type ForgeMediaUnavailable,
} from "@ace/protocol";
import { z } from "zod";
import { base64, gather } from "./bytes.ts";
import type { ForgeReads } from "./forge-reads.ts";

/*
 * Images and videos in pull request and issue text, for the phone (ADR 0096): the daemon asks
 * the forge for them and keeps their bytes, private attachments included, so the phone never
 * contacts GitHub. A URL is resolved exactly as the text wrote it, then its bytes are read by
 * hash. What can't be shown says why in words.
 */

export const ForgeMediaRequest = z.object({
  type: z.literal("forge.media"),
  project: z.string().min(1).max(512),
  repository: ForgeRepository.optional(),
  url: z.string().min(1).max(2048),
  /** `image` where the text asks for an image; `link` for a link alone on its line. */
  role: z.enum(["image", "link"]),
});
export type ForgeMediaRequest = z.infer<typeof ForgeMediaRequest>;

export type Download = (input: FileDownloadInput, signal: AbortSignal) => AsyncIterable<Uint8Array>;

export type MediaReply =
  | {
      type: "forge.media";
      state: "ready";
      kind: "image" | "video";
      mimeType: string;
      width: number | null;
      height: number | null;
      data: string;
    }
  /** A link the forge shows as a plain link. */
  | { type: "forge.media"; state: "none" }
  | { type: "forge.media"; state: "unavailable"; reason: string };

const reasons: Record<ForgeMediaUnavailable, string> = {
  too_large: "Too large to show here",
  unsupported: "Can't be shown here",
  not_found: "No longer on GitHub",
  forbidden: "GitHub didn't allow it",
  offline: "GitHub couldn't be reached",
  rate_limited: "GitHub is limiting requests; try again later",
  failed: "Couldn't load it",
};

const unavailable = (reason: ForgeMediaUnavailable): MediaReply => ({
  type: "forge.media",
  state: "unavailable",
  reason: reasons[reason],
});

export async function readMedia(
  reads: ForgeReads,
  download: Download,
  request: ForgeMediaRequest,
  signal: AbortSignal,
): Promise<MediaReply> {
  const resolved = await reads
    .read(
      {
        op: "forge.media.resolve",
        workspaceId: request.project,
        ...(request.repository ? { repository: request.repository } : {}),
        items: [{ url: request.url, role: request.role }],
      },
      true,
    )
    .catch(() => undefined);
  if (resolved?.resource !== "media") return unavailable("failed");
  const media = resolved.items[0];
  if (!media) return unavailable("failed");
  if (media.state === "none") return { type: "forge.media", state: "none" };
  if (media.state === "unavailable") return unavailable(media.reason);
  const result = await gather(
    download(
      {
        workspaceId: WorkspaceId.parse(request.project),
        op: "forge.media.download",
        sha256: media.sha256,
        offset: 0,
      },
      signal,
    ),
    forgeMediaMaxBytes,
  ).catch(() => undefined);
  if (!result) return unavailable("failed");
  if ("over" in result) return unavailable("too_large");
  return {
    type: "forge.media",
    state: "ready",
    kind: media.kind,
    mimeType: media.mimeType,
    width: media.width ?? null,
    height: media.height ?? null,
    data: base64(result.bytes),
  };
}
