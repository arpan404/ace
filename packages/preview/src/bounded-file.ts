import { open } from "node:fs/promises";

/** Small files start with a 16 KiB allocation. Growth is bounded and geometric. */
export async function readBoundedText(path: string, maxBytes = 4_194_304): Promise<string> {
  const file = await open(path, "r");
  try {
    let buffer = Buffer.allocUnsafe(Math.min(16_384, maxBytes + 1));
    let bytesRead = 0;
    while (bytesRead <= maxBytes) {
      if (bytesRead === buffer.length) {
        const larger = Buffer.allocUnsafe(Math.min(buffer.length * 2, maxBytes + 1));
        buffer.copy(larger, 0, 0, bytesRead);
        buffer = larger;
      }
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead);
      if (chunk.bytesRead === 0) return buffer.toString("utf8", 0, bytesRead);
      bytesRead += chunk.bytesRead;
    }
    throw new Error("Preview file exceeds limit");
  } finally {
    await file.close();
  }
}
