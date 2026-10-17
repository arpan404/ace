import { desktopImageClipboard } from "@/boot/desktop.ts";

/** Clipboards take PNG everywhere; a browser's clipboard takes nothing else. */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((out) => (out ? resolve(out) : reject(new Error("encode"))), "image/png"),
  );
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * Put an image on this device's clipboard. The desktop app writes it natively (no focus or
 * gesture needed, PNG or JPEG kept as they are); a browser gets a PNG `ClipboardItem`, handed a
 * pending blob so Safari keeps the click's activation while the bytes are read.
 */
export async function copyImageToClipboard(
  image: Promise<Blob>,
  scope: object = globalThis,
): Promise<void> {
  const desktop = desktopImageClipboard(scope);
  if (desktop) {
    const blob = await image;
    const ready = blob.type === "image/jpeg" ? blob : await asPng(blob);
    const mimeType = ready.type === "image/jpeg" ? "image/jpeg" : "image/png";
    await desktop.writeImage({ mimeType, data: await base64(ready) });
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": image.then(asPng) })]);
}
