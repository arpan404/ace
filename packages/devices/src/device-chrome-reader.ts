import type { AppDevice as Device, DeviceChrome } from "@ace/protocol/devices";
import { readAndroidSkin, type AndroidSkinSource } from "./android-skin-files.ts";
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
}

export class DeviceChromeReader {
  private readonly sources: DeviceChromeSources;
  private readonly cache = new Map<string, Promise<DeviceChrome | undefined>>();
  constructor(sources: DeviceChromeSources) {
    this.sources = sources;
  }
  /** The device's look, or undefined when its SDK doesn't describe it. */
  async chrome(device: Device): Promise<DeviceChrome | undefined> {
    const key =
      device.platform === "ios"
        ? await this.sources.simulatorType(device).then((type) => type && `ios:${type}`)
        : `android:${this.sources.avdName(device)}`;
    if (!key) return undefined;
    let read = this.cache.get(key);
    if (!read) {
      read =
        device.platform === "ios"
          ? readSimulatorChrome(this.sources.simulator, key.slice("ios:".length))
          : readAndroidSkin(this.sources.android, this.sources.avdName(device));
      this.cache.set(key, read);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value ?? key);
      read.catch(() => this.cache.delete(key));
    }
    return read;
  }
}
