import decoderModule from "jsqr";

/** Rasterize terminal half-blocks as they appear, then scan with an independent decoder. */
export function scanTerminalQr(output: string): string | undefined {
  const lines = output
    .split("\n")
    .filter((line) => line.startsWith("\u001b[30;47m"))
    .map((line) => line.replaceAll("\u001b[30;47m", "").replaceAll("\u001b[0m", ""));
  const columns = lines[0]?.length ?? 0;
  const scale = 4;
  const width = columns * scale;
  const height = lines.length * 2 * scale;
  if (!width || !height) return undefined;
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const moduleRow = Math.floor(y / scale);
      const glyph = lines[Math.floor(moduleRow / 2)]?.[Math.floor(x / scale)];
      const black = glyph === "█" || glyph === (moduleRow % 2 ? "▄" : "▀");
      if (black) {
        const offset = (y * width + x) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
      }
    }
  }
  const decodeQr = typeof decoderModule === "function" ? decoderModule : decoderModule.default;
  const result: unknown = decodeQr(pixels, width, height);
  return result && typeof result === "object" && "data" in result && typeof result.data === "string"
    ? result.data
    : undefined;
}
