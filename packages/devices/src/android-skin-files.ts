import { isAbsolute, join } from "node:path";
import sharp from "sharp";
import type { DeviceChrome } from "@ace/protocol/devices";
import { androidSkinChrome, type SkinImage } from "./android-skin.ts";

/*
 * Finding an emulator's skin: the AVD's config names it (`skin.path`, `skin.name`, or the
 * hardware profile `hw.device.name`), and it lives under the SDK's `skins` directory or the
 * system image's. Every root and read is passed in.
 */

export interface AndroidSkinSource {
  /** Directories holding `<name>.avd` folders and `<name>.ini` files, searched in order. */
  avdRoots: readonly string[];
  /** Android SDK roots, searched in order. */
  sdkRoots: readonly string[];
  /** A file's bytes, or undefined when it can't be read. */
  readFile(path: string): Promise<Uint8Array | undefined>;
}

/** An `.ini` file's `key=value` lines. */
export function iniValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2]);
  }
  return values;
}

/** Image bytes larger than this aren't read (the chrome travels in one message). */
const imageLimit = 700 * 1024;

/** A skin image as a data URL, with its alpha decoded so its shapes can be measured. */
async function skinImage(bytes: Uint8Array, file: string): Promise<SkinImage> {
  const type = file.toLowerCase().endsWith(".png") ? "png" : "webp";
  const url = `data:image/${type};base64,${Buffer.from(bytes).toString("base64")}`;
  const decoded = await sharp(bytes)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => undefined);
  if (!decoded) return { url, alpha: () => undefined };
  const { data, info } = decoded;
  return {
    url,
    alpha: (x, y) =>
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < info.width &&
      y < info.height
        ? data[y * info.width + x]
        : undefined,
  };
}
const plainName = (name: string) => /^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== "..";

async function readText(source: AndroidSkinSource, path: string) {
  const bytes = await source.readFile(path);
  return bytes ? Buffer.from(bytes).toString("utf8") : undefined;
}

async function avdConfig(source: AndroidSkinSource, avd: string) {
  for (const root of source.avdRoots) {
    const pointer = await readText(source, join(root, `${avd}.ini`));
    const path = pointer ? iniValues(pointer).get("path") : undefined;
    for (const directory of [path && isAbsolute(path) ? path : undefined, join(root, `${avd}.avd`)])
      if (directory) {
        const config = await readText(source, join(directory, "config.ini"));
        if (config) return iniValues(config);
      }
  }
  return undefined;
}

function skinDirectories(config: Map<string, string>, sdkRoots: readonly string[]): string[] {
  const path = config.get("skin.path");
  const names = [config.get("skin.name"), config.get("hw.device.name")].filter(
    (name): name is string => name !== undefined && plainName(name) && name !== "_no_skin",
  );
  const systemImage = config.get("image.sysdir.1");
  const candidates = [path && isAbsolute(path) ? path : undefined];
  for (const root of sdkRoots) {
    if (path && !isAbsolute(path) && !path.split(/[/\\]/).includes(".."))
      candidates.push(join(root, path));
    for (const name of names) {
      candidates.push(join(root, "skins", name));
      if (systemImage && !systemImage.split(/[/\\]/).includes(".."))
        candidates.push(join(root, systemImage, "skins", name));
    }
  }
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

/**
 * The look of AVD `avd`'s skin, or undefined when it has none ace can draw (no skin, a skin
 * without a portrait picture, or images too large to send).
 */
export async function readAndroidSkin(
  source: AndroidSkinSource,
  avd: string,
): Promise<DeviceChrome | undefined> {
  if (!plainName(avd)) return undefined;
  const config = await avdConfig(source, avd);
  if (!config) return undefined;
  for (const directory of skinDirectories(config, source.sdkRoots)) {
    const layout = await readText(source, join(directory, "layout"));
    if (!layout) continue;
    return androidSkinChrome(layout, async (file) => {
      const bytes = await source.readFile(join(directory, file));
      if (!bytes || bytes.byteLength > imageLimit) return undefined;
      return skinImage(bytes, file);
    });
  }
  return undefined;
}
