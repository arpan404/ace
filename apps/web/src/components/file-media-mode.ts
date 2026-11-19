import type { PreviewMode } from "./attachment-kind.ts";

/** The previews the browser's own viewers draw: an image, a PDF, audio and video. */
export type MediaMode = Extract<PreviewMode, "image" | "pdf" | "audio" | "video">;

export const isMediaMode = (mode: PreviewMode): mode is MediaMode =>
  mode === "image" || mode === "pdf" || mode === "audio" || mode === "video";

/** The type a blob needs for its viewer: a PDF frame shows the viewer only for a PDF blob. */
export const mediaType = (mode: MediaMode) => (mode === "pdf" ? "application/pdf" : undefined);
