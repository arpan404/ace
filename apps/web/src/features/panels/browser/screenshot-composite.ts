import type { BrowserSizedScreenshot } from "@ace/protocol";

/** Space around and between the captures in the composite, in image pixels. */
const gap = 32;

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * One PNG with the captures side by side, smallest first, tops aligned, on a transparent
 * background. Undefined where the platform can't draw images off screen.
 */
export async function compositeScreenshots(
  images: readonly BrowserSizedScreenshot[],
): Promise<Blob | undefined> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function")
    return undefined;
  const bitmaps = await Promise.all(
    images.map((image) =>
      createImageBitmap(new Blob([bytesOf(image.data)], { type: image.mimeType })),
    ),
  );
  try {
    const width =
      bitmaps.reduce((sum, bitmap) => sum + bitmap.width, 0) + gap * (bitmaps.length + 1);
    const height = Math.max(...bitmaps.map((bitmap) => bitmap.height)) + gap * 2;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    let x = gap;
    for (const bitmap of bitmaps) {
      context.drawImage(bitmap, x, gap);
      x += bitmap.width + gap;
    }
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }
}

/** Put an image on the clipboard; false where the browser won't. */
export async function copyImage(blob: Blob): Promise<boolean> {
  if (typeof ClipboardItem !== "function" || !navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}
