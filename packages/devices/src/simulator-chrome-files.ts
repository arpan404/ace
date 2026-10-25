import { join } from "node:path";
import { z } from "zod";
import type { DeviceChrome } from "@ace/protocol/devices";
import {
  SimulatorChromeFile,
  SimulatorProfile,
  simulatorChrome,
  type ArtReader,
} from "./simulator-chrome.ts";

/*
 * Finding a Simulator device type's files on this Mac and reading them: `simctl` names the
 * device type's bundle, `plutil` turns its binary profile into JSON, and the chrome bundle it
 * names is looked up under the DeviceKit roots. Every path and process is passed in.
 */

export interface SimulatorChromeSource {
  /** `xcrun simctl list devicetypes --json`'s output. */
  deviceTypes(): Promise<string>;
  /** A property list file as JSON text (`plutil -convert json -o - <path>`). */
  plistJson(path: string): Promise<string>;
  /** A file's bytes, or undefined when it can't be read. */
  readFile(path: string): Promise<Uint8Array | undefined>;
  /** Directories holding `*.devicechrome` bundles, searched in order. */
  chromeRoots: readonly string[];
}

const DeviceTypes = z.object({
  devicetypes: z
    .array(z.object({ identifier: z.string().max(512), bundlePath: z.string().max(4096) }).loose())
    .max(4096),
});
const ChromeIdentity = z.object({ identifier: z.string().max(512).optional() }).loose();

/** A resource name from Apple's files is a plain file name, never a path. */
const plainName = (name: string) => /^[^/\\\0]+$/.test(name) && name !== "." && name !== "..";

function parsed<T>(schema: z.ZodType<T>, text: string | undefined): T | undefined {
  if (text === undefined) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function chromeBundle(
  source: SimulatorChromeSource,
  identifier: string,
): Promise<{ directory: string; file: SimulatorChromeFile } | undefined> {
  const last = identifier.split(".").pop() ?? "";
  if (!plainName(last)) return undefined;
  for (const root of source.chromeRoots) {
    const directory = join(root, `${last}.devicechrome`);
    const bytes = await source.readFile(join(directory, "Contents/Resources/chrome.json"));
    const text = bytes ? Buffer.from(bytes).toString("utf8") : undefined;
    const identity = parsed(ChromeIdentity, text);
    if (identity?.identifier !== undefined && identity.identifier !== identifier) continue;
    const file = parsed(SimulatorChromeFile, text);
    if (file) return { directory, file };
  }
  return undefined;
}

/**
 * The look of Simulators of device type `deviceType` (a `com.apple.CoreSimulator.SimDeviceType`
 * identifier), or undefined when this Mac's Xcode doesn't describe it fully.
 */
export async function readSimulatorChrome(
  source: SimulatorChromeSource,
  deviceType: string,
): Promise<DeviceChrome | undefined> {
  const types = parsed(DeviceTypes, await source.deviceTypes().catch(() => undefined));
  const bundle = types?.devicetypes.find((type) => type.identifier === deviceType)?.bundlePath;
  if (!bundle) return undefined;
  const resources = join(bundle, "Contents/Resources");
  const profile = parsed(
    SimulatorProfile,
    await source.plistJson(join(resources, "profile.plist")).catch(() => undefined),
  );
  if (!profile?.chromeIdentifier) return undefined;
  const chrome = await chromeBundle(source, profile.chromeIdentifier);
  if (!chrome) return undefined;
  const read: ArtReader = async (from, name) => {
    if (!plainName(name)) return undefined;
    const directory = from === "profile" ? resources : join(chrome.directory, "Contents/Resources");
    return source.readFile(join(directory, `${name}.pdf`));
  };
  return simulatorChrome(profile, chrome.file, read);
}
