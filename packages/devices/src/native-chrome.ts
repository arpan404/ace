// SPDX-License-Identifier: Apache-2.0

/**
 * A device's real look, read the native way (D3.4): `ace-devices` decides every path, name and
 * bound, the shell reads the SDK's files and runs ace-media's image jobs (ADR 0208). The look
 * is remembered per kind of hardware, as today's `DeviceChromeReader` remembers it, because
 * Apple's and Google's files don't change while ace runs.
 */
import { join } from "node:path";
import type { AppDevice as Device, DeviceChrome, DevicePosture } from "@ace/protocol/devices";
import type { ImageWork } from "@ace/media/images";
import { readSmallFile, svgPng } from "./device-chrome-sources.ts";
import { lookDeadlineMs } from "./device-images.ts";
import { nativeId } from "./commands.ts";
import {
  type ArtPath,
  type ChromeAnswer,
  type ChromeRoots,
  type ReadStep,
  type SkinRead,
  nativeDevices,
} from "./native-devices-addon.ts";
import { pngBody } from "./simulator-body-png.ts";

/** What the shell needs from the platform: its limits, its SDK commands and its reads. */
export interface NativeChromeOptions {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Whether this machine is a Mac, where Simulator looks exist at all. */
  darwin: boolean;
  images: ImageWork;
  readFile?: (path: string) => Promise<Uint8Array | undefined>;
  /** stdout of `xcrun simctl <args>`. */
  simctl(args: readonly string[]): Promise<string>;
  /** stdout of `plutil <args>`. */
  plutil(args: readonly string[]): Promise<string>;
  /** The Simulator's device type identifier, from the inventory. */
  simulatorType(udid: string): Promise<string | undefined>;
  /** The Android SDK roots this machine has. */
  sdkRoots(): string[];
}

/** A panel of a device type's built-in screens, as `ace-devices` answers it. */
interface Panel {
  width: number;
  height: number;
  chromeIdentifier?: string;
  framebufferMask?: string;
  sensorBarImage?: string;
}

/** The prefix an SVG data URL carries before its base64. */
const svgPrefix = "data:image/svg+xml;base64,";

/** One of the addon's bare answers: its JSON value, not an envelope. */
function bare<T>(invoke: () => string): T {
  return JSON.parse(invoke()) as T;
}

export class NativeChromeReader {
  private readonly options: NativeChromeOptions;
  private readonly cache = new Map<string, Promise<DeviceChrome | undefined>>();
  private roots: ChromeRoots | undefined;
  private cap: number | undefined;

  constructor(options: NativeChromeOptions) {
    this.options = options;
  }

  /** The device's look in `posture`, or undefined when its SDK doesn't describe it. */
  async chrome(
    device: Device,
    format: "svg" | "png" = "svg",
    posture?: DevicePosture,
  ): Promise<DeviceChrome | undefined> {
    const open = posture === "open" || posture === "partiallyOpen";
    const key = await this.key(device, open);
    if (!key) return undefined;
    if (format === "png")
      return this.remember(nativeDevices().devicePlatformPngKey(key), async () => {
        const svg = await this.chrome(device, "svg", posture);
        return svg ? this.asPng(svg) : undefined;
      });
    if (device.platform !== "ios")
      return this.remember(key, () => this.androidSkin(nativeId(device)));
    if (!this.options.darwin) return undefined;
    return this.remember(key, () => this.simulatorChrome(device, open));
  }

  /** The key a look is remembered by, decided by `ace-devices`. */
  private async key(device: Device, open: boolean): Promise<string | undefined> {
    const type = device.platform === "ios" ? await this.simulatorType(device) : undefined;
    const key = nativeDevices().devicePlatformChromeKey(
      device.platform,
      nativeId(device),
      type ?? undefined,
      open,
    );
    return key ?? undefined;
  }

  private async simulatorType(device: Device): Promise<string | undefined> {
    if (device.model) return device.model;
    return this.options.simulatorType(nativeId(device));
  }

  private remember(
    key: string,
    read: () => Promise<DeviceChrome | undefined>,
  ): Promise<DeviceChrome | undefined> {
    if (!key) return Promise.resolve(undefined);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = read();
      this.cache.set(key, pending);
      if (this.cache.size > this.cacheCap())
        this.cache.delete(this.cache.keys().next().value ?? key);
      pending.catch(() => this.cache.delete(key));
    }
    return pending;
  }

  /** Looks remembered before the oldest is forgotten, from `ace-devices`. */
  private cacheCap(): number {
    if (this.cap === undefined)
      this.cap = bare<{ cacheCap: number }>(() =>
        nativeDevices().devicePlatformImageLimits(),
      ).cacheCap;
    return this.cap;
  }

  /** The SDK's own folders, read once. */
  private chromeRoots(): ChromeRoots {
    if (!this.roots) {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(this.options.env))
        if (value !== undefined) env[name] = value;
      this.roots = bare<ChromeRoots>(() =>
        nativeDevices().devicePlatformChromeRoots(JSON.stringify(env), this.options.home),
      );
    }
    return this.roots;
  }

  private async readText(path: string): Promise<string | undefined> {
    const read = this.options.readFile ?? readSmallFile;
    const bytes = await read(path);
    return bytes ? Buffer.from(bytes).toString("utf8") : undefined;
  }

  private async readBase64(path: string): Promise<string | undefined> {
    const read = this.options.readFile ?? readSmallFile;
    const bytes = await read(path);
    return bytes ? Buffer.from(bytes).toString("base64") : undefined;
  }

  /**
   * A step-based read: ask `ace-devices` what it still needs, read those files, ask again. A
   * round that reads nothing new ends the read, so a file that can't be read never spins.
   */
  private async gather(
    files: Record<string, string>,
    step: (files: Record<string, string>) => ReadStep,
  ): Promise<ReadStep | undefined> {
    for (let round = 0; round < 8; round++) {
      const answer = step(files);
      if (answer.read.length === 0) return answer;
      let read = 0;
      for (const path of answer.read) {
        if (files[path] !== undefined) continue;
        const text = await this.readText(path);
        if (text === undefined) continue;
        files[path] = text;
        read++;
      }
      if (read === 0) return undefined;
    }
    return undefined;
  }

  /** An AVD's look from its skin: the drawn body around the display. */
  private async androidSkin(avd: string): Promise<DeviceChrome | undefined> {
    const addon = nativeDevices();
    const roots = this.chromeRoots();
    const sdkRoots = JSON.stringify(this.options.sdkRoots());
    const config = await this.gather({}, (files) =>
      bare<ReadStep>(() =>
        addon.devicePlatformAvdConfig(avd, JSON.stringify(roots.avdRoots), JSON.stringify(files)),
      ),
    );
    if (!config?.text) return undefined;
    const directories = bare<string[]>(() =>
      addon.devicePlatformSkinDirectories(config.text ?? "", sdkRoots),
    );
    const layout = await this.gather({}, (files) =>
      bare<ReadStep>(() =>
        addon.devicePlatformSkinLayout(JSON.stringify(directories), JSON.stringify(files)),
      ),
    );
    if (!layout?.text || !layout.directory) return undefined;
    const plan = JSON.parse(addon.devicePlatformSkinOpening(layout.text)) as SkinRead | null;
    if (!plan) return undefined;
    const images: Record<string, { url: string; scan: Array<number | null> }> = {};
    for (const image of plan.images) {
      const path = join(layout.directory, image.file);
      const bytes = await (this.options.readFile ?? readSmallFile)(path);
      if (!bytes) continue;
      const url = addon.devicePlatformSkinImage(Buffer.from(bytes), image.file);
      if (!url) continue;
      images[image.key] = { url, scan: await this.alpha(bytes, image.corner, image.reach) };
    }
    const back = images.back;
    if (!back) return undefined;
    return bare<DeviceChrome>(() =>
      addon.devicePlatformSkinChrome(
        JSON.stringify(plan.plan),
        back.url,
        JSON.stringify(back.scan),
        images.mask?.url,
        images.mask ? JSON.stringify(images.mask.scan) : undefined,
      ),
    );
  }

  /** The alpha along a picture's corner diagonal, one value a step; none outside it. */
  private async alpha(
    bytes: Uint8Array,
    corner: [number, number] | null,
    reach: number,
  ): Promise<Array<number | null>> {
    if (!corner) return [];
    let decoded;
    try {
      decoded = await this.options.images.run({
        inputs: [{ kind: "bytes", bytes }],
        op: { op: "alpha", maxPixels: 16 * 1024 * 1024 },
        deadlineMs: lookDeadlineMs,
      });
    } catch {
      return [];
    }
    const { bytes: data, width, height } = decoded;
    const scan: Array<number | null> = [];
    for (let step = 0; step <= reach; step++) {
      const x = corner[0] + step;
      const y = corner[1] + step;
      scan.push(x >= 0 && y >= 0 && x < width && y < height ? (data[y * width + x] ?? null) : null);
    }
    return scan;
  }

  /** A Simulator device type's look from Xcode's own files. */
  private async simulatorChrome(device: Device, open: boolean): Promise<DeviceChrome | undefined> {
    const addon = nativeDevices();
    const type = await this.simulatorType(device);
    if (!type) return undefined;
    const types = await this.options.simctl(["list", "devicetypes", "--json"]);
    const bundle = addon.devicePlatformDeviceTypeBundle(types, type);
    if (!bundle) return undefined;
    const resources = join(bundle, "Contents/Resources");
    const plist = async (file: string) => {
      try {
        return await this.options.plutil(["-convert", "json", "-o", "-", join(resources, file)]);
      } catch {
        return undefined;
      }
    };
    const [profileText, capabilitiesText] = await Promise.all([
      plist("profile.plist"),
      plist("capabilities.plist"),
    ]);
    const panels = bare<Panel[]>(() =>
      addon.devicePlatformSimulatorPanels(profileText ?? null, capabilitiesText ?? null),
    );
    const panel = (open ? panels[1] : undefined) ?? panels[0];
    if (!panel?.chromeIdentifier) return undefined;
    const identifier = panel.chromeIdentifier;
    const directories = bare<string[]>(() =>
      addon.devicePlatformChromeBundles(identifier, JSON.stringify(this.chromeRoots().chromeRoots)),
    );
    for (const directory of directories) {
      const text = await this.readText(join(directory, "Contents/Resources/chrome.json"));
      if (!text) continue;
      if (!addon.devicePlatformBundleMatches(text, identifier)) continue;
      const paths = JSON.parse(
        addon.devicePlatformSimulatorArtPaths(
          bundle,
          directory,
          text,
          panel.framebufferMask ?? null,
          panel.sensorBarImage ?? null,
        ),
      ) as ArtPath[] | null;
      // A chrome file ace can't read names no art; the next bundle may be the one.
      if (!paths) continue;
      const arts: Record<string, string> = {};
      for (const entry of paths) {
        const bytes = await this.readBase64(entry.path);
        if (bytes) arts[entry.key] = bytes;
      }
      const first = this.simulatorLook(panel, text, arts, undefined);
      if (!first?.paint) return (first?.chrome as DeviceChrome | null) ?? undefined;
      const url = await pngBody(this.options.images)(
        { width: first.paint.width, height: first.paint.height },
        first.paint.pieces,
      );
      if (!url) return undefined;
      const ready = this.simulatorLook(panel, text, arts, url);
      return (ready?.chrome as DeviceChrome | null) ?? undefined;
    }
    return undefined;
  }

  private simulatorLook(
    panel: Panel,
    chrome: string,
    arts: Record<string, string>,
    body: string | undefined,
  ): ChromeAnswer {
    return bare<ChromeAnswer>(() =>
      nativeDevices().devicePlatformSimulatorChrome(
        JSON.stringify(panel),
        chrome,
        JSON.stringify(arts),
        body,
      ),
    );
  }

  /** The same look with every SVG image drawn as PNG, by ace-media. */
  private async asPng(chrome: DeviceChrome): Promise<DeviceChrome | undefined> {
    const addon = nativeDevices();
    const request = JSON.parse(addon.devicePlatformChromeToPng(JSON.stringify(chrome), null)) as {
      svgs: string[];
    };
    const rendered: Record<string, string> = {};
    await Promise.all(
      request.svgs.map(async (url) => {
        const png = await svgPng(
          Buffer.from(url.slice(svgPrefix.length), "base64"),
          this.options.images,
        );
        if (png) rendered[url] = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
      }),
    );
    const answer = JSON.parse(
      addon.devicePlatformChromeToPng(JSON.stringify(chrome), JSON.stringify(rendered)),
    ) as { chrome: DeviceChrome | null };
    return answer.chrome ?? undefined;
  }
}
