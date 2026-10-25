import type { AppDevice as Device, DeviceChrome } from "@ace/protocol/devices";
import { readAndroidSkin, type AndroidSkinSource } from "./android-skin-files.ts";
import { chromeAsPng, type SvgToPng } from "./chrome-raster.ts";
import { readSimulatorChrome, type SimulatorChromeSource } from "./simulator-chrome-files.ts";

/*
 * A device's real look, read once per kind of hardware (a Simulator device type, an AVD) and
 * kept: Apple's and Google's files don't change while ace runs. A read that throws is tried
 * again next time; one that finds nothing is remembered as nothing.
 */

export interface DeviceChromeSources {
  simulator: SimulatorChromeSource;
  android: AndroidSkinSource;
  /** A Simulator's device type identifier, or undefined when it isn't listed. */
  simulatorType(device: Device): Promise<string | undefined>;
  /** The AVD a device stands for. */
  avdName(device: Device): string;
  /** Draws an SVG as PNG, for clients that ask for PNG. */
  svgToPng: SvgToPng;
}

export type ChromeFormat = "svg" | "png";

export class DeviceChromeReader {
  private readonly sources: DeviceChromeSources;
  private readonly cache = new Map<string, Promise<DeviceChrome | undefined>>();
  constructor(sources: DeviceChromeSources) {
    this.sources = sources;
  }
  /** The device's look, or undefined when its SDK doesn't describe it. */
  async chrome(device: Device, format: ChromeFormat = "svg"): Promise<DeviceChrome | undefined> {
    if (format === "png") {
      const key = `png:${await this.key(device)}`;
      return this.remember(key, async () => {
        const chrome = await this.chrome(device);
        return chrome && chromeAsPng(chrome, this.sources.svgToPng);
      });
    }
    const key = await this.key(device);
    return this.remember(key, () =>
      device.platform === "ios"
        ? readSimulatorChrome(this.sources.simulator, key.slice("ios:".length))
        : readAndroidSkin(this.sources.android, this.sources.avdName(device)),
    );
  }
  private async key(device: Device): Promise<string> {
    if (device.platform !== "ios") return `android:${this.sources.avdName(device)}`;
    const type = await this.sources.simulatorType(device);
    return type ? `ios:${type}` : "";
  }
  private remember(
    key: string,
    read: () => Promise<DeviceChrome | undefined>,
  ): Promise<DeviceChrome | undefined> {
    if (!key || key === "png:") return Promise.resolve(undefined);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = read();
      this.cache.set(key, pending);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value ?? key);
      pending.catch(() => this.cache.delete(key));
    }
    return pending;
  }
}
