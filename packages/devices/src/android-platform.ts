import { AppDevice as DeviceSchema, type AppDevice as Device } from "@ace/protocol/devices";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { DeviceError, resolveAndroidSDK, type SDKOptions } from "./sdk.ts";
import {
  adbDevices,
  avdNames,
  avdName,
  nativeId,
  adbShell,
  androidDimensions,
} from "./commands.ts";
export type DeviceCommand = (
  command: string,
  args: readonly string[],
  maxBytes?: number,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;
export class AndroidPlatform {
  private readonly options: SDKOptions;
  private readonly run: DeviceCommand;
  private readonly spawn: typeof spawnSupervised;
  private readonly emulators = new Map<string, SupervisedProcess>();
  private readonly serialNames = new Map<string, string>();
  private readonly inventory = new Map<string, Device>();
  private readonly pendingBoots = new Set<string>();
  private readonly ports = new Set<number>();
  private closed = false;
  constructor(options: SDKOptions, run: DeviceCommand, spawn = spawnSupervised) {
    this.options = options;
    this.run = run;
    this.spawn = spawn;
  }
  resolve() {
    return resolveAndroidSDK(this.options);
  }
  async list(): Promise<Device[]> {
    const { adb, emulator } = await this.resolve();
    const [installed, connected] = await Promise.all([
      this.run(emulator, ["-list-avds"], 256 * 1024),
      this.run(adb, ["devices", "-l"], 128 * 1024),
    ]);
    const devices = new Map<string, Device>(
      avdNames(installed.stdout).map((name) => [
        name,
        { id: `android:${name}`, platform: "android", name, state: "shutdown" },
      ]),
    );
    const transports = adbDevices(connected.stdout);
    const connectedSerials = new Set(transports.map(({ serial }) => serial));
    for (const serial of this.serialNames.keys())
      if (!connectedSerials.has(serial)) this.serialNames.delete(serial);
    for (const { serial, state } of transports) {
      let name = this.serialNames.get(serial) ?? serial;
      if (state === "booted") {
        name = avdName((await this.run(adb, ["-s", serial, "emu", "avd", "name"], 4096)).stdout);
        this.serialNames.set(serial, name);
      }
      const existing = devices.get(name);
      if (existing?.serial && existing.serial !== serial)
        throw new DeviceError(
          "busy",
          "Multiple emulator instances use the same AVD",
          "Close duplicate instances before selecting this AVD in ace.",
        );
      devices.set(name, { id: `android:${name}`, platform: "android", name, state, serial });
    }
    const result = [...devices.values()].map((device) => DeviceSchema.parse(device));
    this.inventory.clear();
    for (const device of result) this.inventory.set(device.id, device);
    return result;
  }
  async current(input: Device): Promise<Device> {
    const device = DeviceSchema.parse(input);
    nativeId(device);
    const found = (await this.list()).find((candidate) => candidate.id === device.id);
    if (!found)
      throw new DeviceError(
        "not_found",
        "Device is no longer available",
        "Refresh the device list.",
      );
    return found;
  }
  async serial(device: Device): Promise<string> {
    DeviceSchema.parse(device);
    nativeId(device);
    const cached = this.inventory.get(device.id);
    const current = cached?.state === "booted" ? cached : await this.current(device);
    if (current.state !== "booted" || !current.serial)
      throw new DeviceError(
        current.state === "unauthorized" ? "permission_denied" : "not_booted",
        "Android emulator is not available for input",
        "Boot the emulator and authorize adb before retrying.",
      );
    const { adb } = await this.resolve();
    const name = avdName(
      (await this.run(adb, ["-s", current.serial, "emu", "avd", "name"], 4096)).stdout,
    );
    if (name !== nativeId(device))
      throw new DeviceError(
        "not_found",
        "Emulator transport now belongs to another AVD",
        "Refresh the device list before retrying.",
      );
    return current.serial;
  }
  async adb(device: Device, args: readonly string[], maxBytes?: number, authorize?: () => void) {
    const serial = await this.serial(device);
    const { adb } = await this.resolve();
    authorize?.();
    return this.run(adb, ["-s", serial, ...args], maxBytes);
  }
  async captureDimensions(device: Device): Promise<{ width: number; height: number }> {
    const { stdout } = await this.adb(device, adbShell(["wm", "size"]), 4096);
    return androidDimensions(stdout);
  }

  async boot(input: Device, authorize?: () => void): Promise<void> {
    const device = await this.current(input);
    if (device.state === "booted") return;
    if (device.state !== "shutdown")
      throw new DeviceError(
        "not_booted",
        "Emulator transport is offline or unauthorized",
        "Restart the emulator or authorize adb.",
      );
    if (
      this.pendingBoots.has(device.id) ||
      this.emulators.has(device.id) ||
      this.emulators.size + this.pendingBoots.size >= 4
    )
      throw new DeviceError(
        "busy",
        "Emulator process limit or boot already in progress",
        "Wait for the current boot or shut down another emulator.",
      );
    this.pendingBoots.add(device.id);
    try {
      const { adb, emulator } = await this.resolve();
      const used = new Set(
        adbDevices((await this.run(adb, ["devices", "-l"], 128 * 1024)).stdout).map(
          ({ serial }) => serial,
        ),
      );
      let port = 5554;
      while (used.has(`emulator-${port}`) || this.ports.has(port)) port += 2;
      if (port > 5682)
        throw new DeviceError(
          "limit",
          "No emulator console port available",
          "Close unused emulators.",
        );
      if (this.closed)
        throw new DeviceError(
          "command_failed",
          "Device service is closed",
          "Restart the device service.",
        );
      this.ports.add(port);
      let proc: SupervisedProcess;
      try {
        authorize?.();
        proc = this.spawn({
          command: emulator,
          args: ["-avd", nativeId(device), "-port", String(port)],
          env: this.options.env,
          name: "device-emulator",
          maxLineBytes: 16 * 1024,
        });
      } catch (error) {
        this.ports.delete(port);
        throw error;
      }
      this.emulators.set(device.id, proc);
      const controller = new AbortController();
      void proc.exited.then(() => {
        controller.abort();
        this.ports.delete(port);
        if (this.emulators.get(device.id) === proc) this.emulators.delete(device.id);
      });
      try {
        await Promise.race([
          (async () => {
            await this.run(
              adb,
              ["-s", `emulator-${port}`, "wait-for-device"],
              4096,
              120_000,
              controller.signal,
            );
            await this.run(
              adb,
              [
                "-s",
                `emulator-${port}`,
                "shell",
                'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done',
              ],
              4096,
              120_000,
              controller.signal,
            );
          })(),
          proc.exited.then(() => {
            throw new DeviceError(
              "command_failed",
              "Emulator exited during boot",
              "Check the AVD configuration in Android Studio.",
            );
          }),
        ]);
      } catch (error) {
        await proc.stop({ graceMs: 0 });
        throw error;
      }
    } finally {
      this.pendingBoots.delete(device.id);
    }
  }
  async shutdown(device: Device, authorize?: () => void): Promise<void> {
    try {
      await this.adb(device, ["emu", "kill"], undefined, authorize);
    } finally {
      authorize?.();
      await this.emulators.get(device.id)?.stop({ graceMs: 0 });
    }
  }
  async logs(device: Device): Promise<{ command: string; args: string[] }> {
    const serial = await this.serial(device);
    const { adb } = await this.resolve();
    return { command: adb, args: ["-s", serial, "logcat", "-v", "threadtime", "-T", "1"] };
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.emulators.values()].map((proc) => proc.stop({ graceMs: 0 })));
    this.emulators.clear();
    this.serialNames.clear();
    this.inventory.clear();
    this.ports.clear();
  }
}
