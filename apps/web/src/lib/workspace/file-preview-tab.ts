import * as z from "zod/mini";
import type { OpenRequest, WorkspaceTab } from "./model.ts";

/*
 * A side panel tab showing one file that isn't in the thread's checkout: a file an assistant
 * message links to, one an agent saved (an artifact), or one sent with a message. Its data is
 * kept in local storage, so it is decoded before a read. A file only this browser holds (an
 * unsent attachment) has no lasting source, so it never becomes a tab.
 */

const text = z.string().check(z.minLength(1), z.maxLength(4096));
const size = z.number().check(z.int(), z.gte(0));

export const FilePreviewSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("link"), threadId: text, itemId: text, reference: text }),
  z.object({ kind: z.literal("artifact"), threadId: text, artifactId: text, bytes: size }),
  z.object({
    kind: z.literal("attachment"),
    threadId: text,
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
    bytes: size,
  }),
]);
export type FilePreviewSource = z.infer<typeof FilePreviewSource>;

export const FilePreviewTabData = z.object({
  name: text,
  mimeType: z.optional(z.string().check(z.maxLength(255))),
  /** The daemon's reading of the bytes (`pdf`, `image`, `text`…), when it made one. */
  kind: z.optional(z.enum(["image", "pdf", "text", "binary"])),
  bytes: z.optional(size),
  source: FilePreviewSource,
});
export type FilePreviewTabData = z.infer<typeof FilePreviewTabData>;

export const filePreviewTabKind = "file-preview";

const identity = (source: FilePreviewSource) =>
  source.kind === "link"
    ? `link:${source.threadId}:${source.itemId}:${source.reference}`
    : source.kind === "artifact"
      ? `artifact:${source.threadId}:${source.artifactId}`
      : `attachment:${source.threadId}:${source.sha256}`;

/** The tab for one file: opening the same file again shows the tab already open. */
export function filePreviewTab(data: FilePreviewTabData): OpenRequest {
  return { kind: filePreviewTabKind, id: identity(data.source), title: data.name, data };
}

export function filePreviewTabData(tab: WorkspaceTab): FilePreviewTabData | undefined {
  const parsed = FilePreviewTabData.safeParse(tab.data);
  return parsed.success ? parsed.data : undefined;
}
