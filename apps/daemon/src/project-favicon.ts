import type { PinnedDirectory } from "@ace/workspace";
import { ProjectIcon } from "@ace/protocol";
import { rasterPng } from "./icons/icon-image.ts";

const directories = [
  "",
  "public",
  "static",
  "app",
  "src/app",
  "src",
  "apps/web/public",
  "frontend/public",
];
const names = ["favicon.ico", "favicon.png", "favicon.svg", "favicon.webp", "icon.png", "icon.svg"];
const byteLimit = 96_000;

async function raster(bytes: Buffer, svg: boolean): Promise<string | null | undefined> {
  const png = await rasterPng(bytes, svg);
  if (!png) return png;
  const value = `data:image/png;base64,${png.toString("base64")}`;
  return ProjectIcon.safeParse(value).success ? value : null;
}

async function ico(bytes: Buffer): Promise<string | null | undefined> {
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  const count = bytes.readUInt16LE(4);
  if (count < 1 || count > 16 || bytes.length < 6 + 16 * count) return null;
  let unavailable = false;
  for (let index = 0; index < count; index++) {
    const entry = 6 + 16 * index;
    const length = bytes.readUInt32LE(entry + 8),
      offset = bytes.readUInt32LE(entry + 12);
    if (length < 40 || offset < 6 + 16 * count || offset + length > bytes.length) continue;
    const image = bytes.subarray(offset, offset + length);
    if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      const decoded = await raster(image, false);
      if (decoded) return decoded;
      unavailable ||= decoded === undefined;
      continue;
    }
    // Windows DIB icons contain an XOR bitmap followed by a transparency mask.
    const header = image.readUInt32LE(0),
      width = image.readInt32LE(4),
      height = image.readInt32LE(8);
    const bits = image.readUInt16LE(14),
      colors = image.readUInt32LE(32);
    if (
      header !== 40 ||
      width < 1 ||
      width > 256 ||
      height !== 2 * (bytes[entry + 1] || 256) ||
      width !== (bytes[entry] || 256) ||
      image.readUInt16LE(12) !== 1 ||
      ![1, 4, 8, 24, 32].includes(bits) ||
      image.readUInt32LE(16) !== 0
    )
      continue;
    const palette = bits <= 8 ? (colors || 2 ** bits) * 4 : 0;
    if (colors > 256 || palette > 1024) continue;
    const xor = Math.ceil((width * bits) / 32) * 4 * (height / 2);
    const mask = Math.ceil(width / 32) * 4 * (height / 2);
    if (header + palette + xor + mask > image.length) continue;
    return `data:image/x-icon;base64,${bytes.toString("base64")}`;
  }
  return unavailable ? undefined : null;
}

/** At most 48 known names, four decode attempts and 96 KiB per file. Never follows links. */
export async function discoverProjectFavicon(
  root: PinnedDirectory,
): Promise<string | null | undefined> {
  let attempts = 0;
  let unavailable = false;
  for (const path of directories) {
    const children: PinnedDirectory[] = [];
    let directory = root;
    try {
      for (const part of path.split("/").filter(Boolean)) {
        directory = directory.child(part);
        children.push(directory);
      }
      for (const name of names) {
        let bytes: Buffer;
        try {
          bytes = directory.readBytes(name, byteLimit);
        } catch {
          continue;
        }
        if (++attempts > 4) return unavailable ? undefined : null;
        const icon = name.endsWith(".ico")
          ? await ico(bytes)
          : await raster(bytes, name.endsWith(".svg"));
        if (icon) return icon;
        unavailable ||= icon === undefined;
      }
    } catch {
      /* A missing or linked candidate directory is not a project failure. */
    } finally {
      for (const child of children.toReversed()) await child.close();
    }
  }
  return unavailable ? undefined : null;
}
