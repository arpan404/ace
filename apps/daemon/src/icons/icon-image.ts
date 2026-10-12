/*
 * Icon bytes from outside (a project's favicon, a site's favicon, an app's icon) made safe to
 * show: SVGs only without scripts, styles or external references, everything rasterised to a
 * PNG of at most 64px through one bounded decode queue.
 */

let decoder: Promise<typeof import("sharp")> | undefined;
let decoding = Promise.resolve();
let queued = 0;

export function safeSvg(bytes: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  text = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml\s[\s\S]*?\?>/g, "");
  return (
    /^\s*<svg(?:\s|>)/i.test(text) &&
    !/<!|<\?|<(?:[\w.-]+:)?(?:script|foreignObject|image|style)\b|\bxml:base\s*=|\bstyle\s*=|\bon\w+\s*=|\b(?:xlink:)?href\s*=\s*["'](?!#)|\burl\s*\(\s*["']?(?!#)/i.test(
      text,
    )
  );
}

type Input = Buffer | { raw: Buffer; width: number; height: number };

/**
 * A PNG of at most 64x64. Null when the bytes are not an image ace will show; undefined when the
 * decoder is busy or unavailable, which may pass.
 */
export async function rasterPng(input: Input, svg = false): Promise<Buffer | null | undefined> {
  if (svg && Buffer.isBuffer(input) && !safeSvg(input)) return null;
  if (queued >= 8) return undefined;
  queued++;
  const previous = decoding;
  const finished = Promise.withResolvers<void>();
  decoding = finished.promise;
  try {
    await previous;
    const sharp = await (decoder ??= import("sharp")
      .then((module) => module.default)
      .catch((error) => {
        decoder = undefined;
        throw error;
      }));
    const source = Buffer.isBuffer(input)
      ? sharp(input, { limitInputPixels: 1_048_576, animated: false, failOn: "warning" })
      : sharp(input.raw, { raw: { width: input.width, height: input.height, channels: 4 } });
    return await source
      .resize({ width: 64, height: 64, fit: "inside", withoutEnlargement: true })
      .timeout({ seconds: 1 })
      .png()
      .toBuffer();
  } catch {
    // Decoder availability and timeouts are transient, unlike an absent file.
    return undefined;
  } finally {
    queued--;
    finished.resolve();
  }
}
