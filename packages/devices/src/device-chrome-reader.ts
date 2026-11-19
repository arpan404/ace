import type { AppDevice as Device, DeviceChrome, DevicePosture } from "@ace/protocol/devices";
import { readAndroidSkin, type AndroidSkinSource } from "./android-skin-files.ts";
import { chromeAsPng, type SvgToPng } from "./chrome-raster.ts";
import { readSimulatorChrome, type SimulatorChromeSource } from "./simulator-chrome-files.ts";

/*
 * A device's real look, read once per kind of hardware (a Simulator device type, an AVD) and,
 * for a foldable, per screen it shows, and kept: Apple's and Google's files don't change while
 * ace runs. A read that throws is tried
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
  /**
   * The device's look in `posture` (a foldable's cover or inner screen), or undefined when its
   * SDK doesn't describe it.
   */
  async chrome(
    device: Device,
    format: ChromeFormat = "svg",
    posture?: DevicePosture,
  ): Promise<DeviceChrome | undefined> {
    const open = posture === "open" || posture === "partiallyOpen";
    if (format === "png") {
      const key = `png:${await this.key(device, open)}`;
      return this.remember(key, async () => {
        const chrome = await this.chrome(device, "svg", posture);
        return chrome && chromeAsPng(chrome, this.sources.svgToPng);
      });
    }
    if (device.platform !== "ios") {
      const avd = this.sources.avdName(device);
      return this.remember(`android:${avd}`, () => readAndroidSkin(this.sources.android, avd));
    }
    const type = await this.sources.simulatorType(device);
    if (!type) return undefined;
    return this.remember(`ios:${type}:${open ? "open" : "closed"}`, () =>
      readSimulatorChrome(this.sources.simulator, type, open ? "open" : "closed"),
    );
  }
  private async key(device: Device, open: boolean): Promise<string> {
    if (device.platform !== "ios") return `android:${this.sources.avdName(device)}`;
    const type = await this.sources.simulatorType(device);
    return type ? `ios:${type}:${open ? "open" : "closed"}` : "";
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
