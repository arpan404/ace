import type { z } from "zod";
import type { ClipboardImage } from "../../shared/contract.ts";

/** The slice of Electron's `nativeImage` and `clipboard` this needs; injected for tests. */
export interface ClipboardNative {
  decode(bytes: Buffer): { isEmpty(): boolean; toPNG(): Buffer };
  writePng(png: Buffer): Promise<void>;
}

/**
 * Put an already-bounded image (`ClipboardImage`) on the clipboard as PNG. Bytes that don't
 * decode as an image are refused instead of replacing what the clipboard held.
 */
export async function writeClipboardImage(
  request: z.output<typeof ClipboardImage>,
  native: ClipboardNative,
): Promise<void> {
  const image = native.decode(Buffer.from(request.data, "base64"));
  if (image.isEmpty()) throw new Error("The image couldn't be read");
  await native.writePng(image.toPNG());
}
