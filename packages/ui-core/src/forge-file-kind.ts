import { ForgeImageType, type ForgeFile } from "@ace/protocol";
import { imageType, isMarkdownPath } from "./checkout-files.ts";

/**
 * How the Code tab draws a hosted file:
 * - `patch`: GitHub's own patch (or a rename with nothing to show);
 * - `image`: GitHub withheld it and it is an image, drawn from both sides' bytes;
 * - `content`: GitHub withheld the patch (too large for its page, or binary), so both sides are
 *   read as it nears the viewport and diffed here;
 * - `large`: as `content`, but so many lines changed that it reads only when asked.
 */
export type HostedFileShow = "patch" | "image" | "content" | "large";

/** Past this many changed lines a withheld diff reads only when asked. */
export const loadOnRequestAbove = 5_000;

/** The image type the page draws this path as; SVG is text, diffed as text. */
export function hostedImageType(path: string): ForgeImageType | undefined {
  return ForgeImageType.safeParse(imageType(path)).data;
}

export function hostedFileShow(file: ForgeFile): HostedFileShow {
  if (file.patch !== null && !file.truncated) return "patch";
  // A pure rename has no patch, and nothing else to read.
  if (file.status === "renamed" && !file.additions && !file.deletions) return "patch";
  if (hostedImageType(file.path)) return "image";
  return file.additions + file.deletions > loadOnRequestAbove ? "large" : "content";
}

/** Files read better drawn than as source; each can switch to its source diff. */
export function renderedKind(path: string): "markdown" | "notebook" | undefined {
  if (isMarkdownPath(path)) return "markdown";
  return /\.ipynb$/i.test(path) ? "notebook" : undefined;
}
