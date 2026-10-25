/*
 * A small still of an image the person attached, as an inline `data:` URL a saved draft can
 * keep: the composer's preview comes back with the draft, on a page that no longer holds the
 * file and without asking the daemon. Bounded so a draft full of screenshots stays small.
 */

/** The longest side of a still, in pixels: sharp in a composer chip on a 2× screen. */
const side = 240;
/** A still longer than this (as text) is not kept; the chip falls back to the daemon's copy. */
export const stillLimit = 40_000;

/** The still of `file`, or undefined when this browser can't decode or encode it. */
export async function imageStill(file: Blob): Promise<string | undefined> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, side / bitmap.width, side / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // Browsers that can't write WebP hand back PNG, which is far larger: JPEG instead.
    let still = canvas.toDataURL("image/webp", 0.72);
    if (!still.startsWith("data:image/webp")) still = canvas.toDataURL("image/jpeg", 0.75);
    return still.length <= stillLimit ? still : undefined;
  } catch {
    return undefined;
  }
}
