import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { join } from "node:path";
import type { AppDevice as Device } from "@ace/protocol/devices";
import { nativeId } from "./commands.ts";
import type { DeviceChromeSources } from "./device-chrome-reader.ts";
import { androidSdkRoots } from "./sdk.ts";

/*
 * Where this machine keeps device looks: Xcode's DeviceKit chrome bundles, the AVD folders and
 * the Android SDKs. The platform passes in how it runs `simctl` and `plutil`.
 */

/** Files the chrome reads are small; anything bigger isn't device art. */
const fileLimit = 4 * 1024 * 1024;

export async function readSmallFile(path: string): Promise<Uint8Array | undefined> {
  try {
    const bytes = await readFile(path);
    return bytes.byteLength <= fileLimit ? new Uint8Array(bytes) : undefined;
  } catch {
    return undefined;
  }
}

/** The longest side a PNG look image is drawn at, in pixels. */
const pngLongest = 2400;

/** An SVG drawn as PNG at three pixels per unit (a phone's points at 3×), at most 2400 wide. */
export async function svgPng(svg: Buffer): Promise<Buffer | undefined> {
  try {
    const { width, height } = await sharp(svg).metadata();
    if (!width || !height) return undefined;
    const factor = Math.min(3, pngLongest / Math.max(width, height));
    return await sharp(svg, { density: 72 * factor })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    return undefined;
  }
}

export function deviceChromeSources(options: {
  home: string;
  env: NodeJS.ProcessEnv;
  /** stdout of `xcrun simctl <args>`. */
  simctl(args: readonly string[]): Promise<string>;
  /** stdout of `plutil <args>`. */
  plutil(args: readonly string[]): Promise<string>;
  /** The Simulator's device type identifier, from the inventory. */
  simulatorType(udid: string): Promise<string | undefined>;
  readFile?: (path: string) => Promise<Uint8Array | undefined>;
}): DeviceChromeSources {
  const read = options.readFile ?? readSmallFile;
  const { env, home } = options;
  const userHome = env["ANDROID_USER_HOME"];
  return {
    simulator: {
      deviceTypes: () => options.simctl(["list", "devicetypes", "--json"]),
      plistJson: (path) => options.plutil(["-convert", "json", "-o", "-", path]),
      readFile: read,
      chromeRoots: [
        "/Library/Developer/DeviceKit/Chrome",
        join(home, "Library/Developer/DeviceKit/Chrome"),
      ],
    },
    android: {
      avdRoots: [
        ...new Set(
          [
            env["ANDROID_AVD_HOME"],
            userHome ? join(userHome, "avd") : undefined,
            join(home, ".android/avd"),
          ].filter((root): root is string => Boolean(root)),
        ),
      ],
      sdkRoots: androidSdkRoots({ home, env }),
      readFile: read,
    },
    simulatorType: async (device: Device) =>
      device.model ?? options.simulatorType(nativeId(device)),
    avdName: (device: Device) => nativeId(device),
    svgToPng: svgPng,
  };
}
