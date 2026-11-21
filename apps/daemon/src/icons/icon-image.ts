import { ImageError, type ImageWork } from "@ace/media/images";

/*
 * Icon bytes from outside (a project's favicon, a site's favicon, an app's icon) made safe to
 * show: SVGs only without scripts, styles or external references, everything rasterised by
 * ace-media (ADR 0208) to a PNG of at most 64px. ICO files are read there too: the entry
 * closest to 64px, an embedded PNG or a 24/32-bit bitmap.
 */

/**
 * Whether an SVG is safe to decode: no scripts, embedded documents, images, style sheets or
 * references outside itself. An app icon installed on this machine may also carry inline
 * `style` attributes (GNOME's do); a downloaded or a repository's icon may not.
 */
function safeSvg(bytes: Buffer, installed = false): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  text = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml\s[\s\S]*?\?>/g, "");
  return (
    /^\s*<svg(?:\s|>)/i.test(text) &&
    !/<!|<\?|<(?:[\w.-]+:)?(?:script|foreignObject|image|style)\b|\bxml:base\s*=|\bon\w+\s*=|\b(?:xlink:)?href\s*=\s*["'](?!#)|\burl\s*\(\s*["']?(?!#)/i.test(
      text,
    ) &&
    (installed || !/\bstyle\s*=/i.test(text))
  );
}

/** Markup: what an SVG starts with, whatever the caller thought the bytes were. */
function markup(bytes: Buffer): boolean {
  return bytes
    .subarray(0, 64)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .startsWith("<");
}

/** How long ace-media may take with one icon, its start included. */
const iconDeadlineMs = 5_000;

export interface IconImages {
  /**
   * A PNG of at most 64x64. Null when the bytes are not an image ace will show; undefined when
   * the decoder is busy or unavailable, which may pass.
   */
  rasterPng(bytes: Buffer, svg?: boolean): Promise<Buffer | null | undefined>;
  /** An app icon installed on this machine (a Linux icon theme's PNG or SVG) as a PNG. */
  installedIconPng(bytes: Buffer): Promise<Buffer | null | undefined>;
}

export function iconImages(images: ImageWork): IconImages {
  const decode = async (bytes: Buffer): Promise<Buffer | null | undefined> => {
    try {
      const png = await images.run({
        inputs: [{ kind: "bytes", bytes }],
        op: {
          op: "fit",
          maxPixels: 1_048_576,
          width: 64,
          height: 64,
          autoOrient: false,
          output: { format: "png" },
        },
        deadlineMs: iconDeadlineMs,
      });
      return Buffer.from(png.bytes);
    } catch (error) {
      // A decode that may work later is "later"; bytes ace-media refuses are no image for good.
      return error instanceof ImageError && error.passing ? undefined : null;
    }
  };
  return {
    // SVG markup passes the strict check whether or not the caller said it was SVG.
    rasterPng: async (bytes, svg = false) =>
      (svg || markup(bytes)) && !safeSvg(bytes) ? null : decode(bytes),
    installedIconPng: async (bytes) =>
      markup(bytes) && !safeSvg(bytes, true) ? null : decode(bytes),
  };
}

/** Icons where no image work was given: every one may come later. */
export const noIconImages: IconImages = {
  rasterPng: async () => undefined,
  installedIconPng: async () => undefined,
};
