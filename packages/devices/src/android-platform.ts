import { z } from "zod";
import { AndroidInputShell } from "./android-input-shell.ts";
import { AndroidUiHelpers } from "./android-ui-helper.ts";
import { AppDevice as DeviceSchema, type AppDevice as Device } from "@ace/protocol/devices";
import { probeOutput, spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { armEmulatorNote, DeviceError, resolveAndroidSDK, type SDKOptions } from "./sdk.ts";
import { emulatorBootArgs } from "./emulator-args.ts";
import {
  adbTransports,
  blockedError,
  hardwareSerial,
  physicalIdPart,
  transportKind,
  type AdbTransport,
} from "./adb-transports.ts";
import { androidInventory, type DeviceHardware } from "./android-inventory.ts";
import { avdNames, avdNameOrUndefined, nativeId, adbShell, androidDimensions } from "./commands.ts";
export type DeviceCommand = (
  command: string,
  args: readonly string[],
  maxBytes?: number,
  timeoutMs?: number,
  signal?: AbortSignal,
  authorize?: () => void,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;
export type AndroidOptions = SDKOptions & {
  toolsDirectory?: string;
  /**
   * Whether an emulator ace boots opens its own window. Read at each boot; omitted or failing,
   * the emulator runs without one.
   */
  emulatorWindow?: () => boolean | Promise<boolean>;
};
export class AndroidPlatform {
  private readonly options: AndroidOptions;
  private readonly run: DeviceCommand;
  private readonly spawn: typeof spawnSupervised;
  private readonly emulators = new Map<string, SupervisedProcess>();
  private readonly ownedSerials = new Map<string, string>();
  private readonly serialNames = new Map<string, string>();
  private readonly inventory = new Map<string, Device>();
  private readonly transportWatchers = new Set<{
    id: string;
    serial: string;
    fail(error: DeviceError): void;
  }>();
  private readonly pendingBoots = new Set<string>();
  private readonly ports = new Set<number>();
  private duplicate = false;
  /** How each listed device is reached, and why it can't be used yet when it can't. */
  private readonly transports = new Map<string, Pick<AdbTransport, "kind" | "block">>();
  /** `ro.serialno` and the Android release of each phone or network device, by adb serial. */
  private readonly hardware = new Map<string, DeviceHardware>();
  private blocked: DeviceError[] = [];
  private noEmulator = false;
  diagnostics() {
    return [
      ...(this.duplicate
        ? [
            new DeviceError(
              "busy",
              "An Android emulator has duplicate instances",
              "Close duplicate emulator windows before controlling that device.",
            ),
          ]
        : []),
      ...this.blocked,
      ...(this.noEmulator ? [armEmulatorNote()] : []),
    ];
  }
  private closed = false;
  private readonly inputs = new Map<string, AndroidInputShell>();
  private readonly openingInputs = new Map<string, Promise<AndroidInputShell>>();
  /** ace's own UiAutomation reader; only where ace manages device tools (the daemon). */
  private readonly uiHelpers: AndroidUiHelpers | undefined;
  constructor(options: AndroidOptions, run: DeviceCommand, spawn = spawnSupervised) {
    this.options = options;
    this.run = run;
    this.spawn = spawn;
    this.uiHelpers =
      options.toolsDirectory && options.env["ACE_ANDROID_UI_HELPER"] !== "off"
        ? new AndroidUiHelpers({
            env: options.env,
            spawn,
            after:
              options.after ??
              ((ms, fire) => {
                const timer = setTimeout(fire, ms);
                return () => clearTimeout(timer);
              }),
            install: async (serial, local, remote) => {
              const { adb } = await this.resolve();
              await this.run(adb, ["-s", serial, "push", local, remote], 64 * 1024, 30_000);
            },
          })
        : undefined;
  }
  resolve() {
    return resolveAndroidSDK(this.options);
  }
  async list(): Promise<Device[]> {
    const { adb, emulator } = await this.resolve();
    const [installed, connected] = await Promise.all([
      emulator ? this.run(emulator, ["-list-avds"], 256 * 1024) : undefined,
      this.run(adb, ["devices", "-l"], 128 * 1024),
    ]);
    this.noEmulator =
      !emulator && this.options.platform === "linux" && this.options.arch === "arm64";
    const transports = adbTransports(connected.stdout);
    const connectedSerials = new Set(transports.map(({ serial }) => serial));
    for (const serial of this.serialNames.keys())
      if (!connectedSerials.has(serial)) this.serialNames.delete(serial);
    for (const serial of this.hardware.keys())
      if (!connectedSerials.has(serial)) this.hardware.delete(serial);
    const physical = transports.filter((transport) => transport.kind !== "emulator");
    const [named] = await Promise.all([
      Promise.all(
        transports
          .filter((transport) => transport.kind === "emulator")
          .map(async ({ serial, state }) => {
            let name = this.serialNames.get(serial);
            if (!name && state === "booted") {
              name = await this.emulatorName(adb, serial);
              if (name) this.serialNames.set(serial, name);
            }
            return { serial, state, name: name ?? serial };
          }),
      ),
      Promise.all(
        physical.map(async ({ serial, state }) => {
          if (state !== "booted" || this.hardware.has(serial)) return;
          const found = await this.hardwareOf(adb, serial);
          if (found) this.hardware.set(serial, found);
        }),
      ),
    ]);
    const bootingSerials = new Set([...this.pendingBoots].map((id) => this.ownedSerials.get(id)));
    const listed = androidInventory({
      avds: avdNames(installed?.stdout ?? ""),
      // An emulator ace is booting shows as the AVD it is, not as an offline transport.
      emulators: named.filter(
        ({ serial, state }) => !(state === "offline" && bootingSerials.has(serial)),
      ),
      physical,
      hardware: this.hardware,
      platform: this.options.platform,
    });
    this.duplicate = listed.duplicate;
    this.blocked = listed.blocked;
    this.transports.clear();
    for (const [id, kind] of listed.transports) this.transports.set(id, kind);
    const devices = listed.devices;
    for (const [id, shell] of this.inputs) {
      const current = devices.find((device) => device.id === id);
      if (current?.state !== "booted" || current.serial !== shell.serial) {
        this.inputs.delete(id);
        void shell.close();
      }
    }
    this.uiHelpers?.prune((id) => {
      const current = devices.find((device) => device.id === id);
      return current?.state === "booted" ? current.serial : undefined;
    });
    const result = devices.map((device) =>
      DeviceSchema.parse({
        ...device,
        name: /^emulator-\d+$/.test(device.name) ? "Android emulator" : device.name,
      }),
    );
    this.inventory.clear();
    for (const device of result) this.inventory.set(device.id, device);
    for (const watcher of this.transportWatchers) {
      const device = this.inventory.get(watcher.id);
      if (device?.state !== "booted" || device.serial !== watcher.serial)
        watcher.fail(this.identityError());
    }
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
    if (current.state !== "booted" || !current.serial) throw this.unavailable(current);
    const { adb } = await this.resolve();
    if ((await this.identity(adb, current.serial)) !== nativeId(device))
      throw new DeviceError(
        "not_found",
        "This adb transport now belongs to another device",
        "Refresh the device list before retrying.",
      );
    return current.serial;
  }
  async adb(
    device: Device,
    args: readonly string[],
    maxBytes?: number,
    authorize?: () => void,
    timeoutMs?: number,
  ) {
    const serial = await this.serial(device);
    const { adb } = await this.resolve();
    authorize?.();
    return this.run(adb, ["-s", serial, ...args], maxBytes, timeoutMs, undefined, authorize);
  }
  async input(
    device: Device,
    args: readonly string[],
    authorize: () => void,
    timeoutMs = 5000,
  ): Promise<void> {
    if (args[0] !== "shell" || args.length !== 2 || !args[1])
      throw new Error("Expected quoted Android shell input");
    authorize();
    const shell = await this.inputShell(device, authorize);
    try {
      await shell.send(args[1], authorize, timeoutMs);
    } catch (error) {
      if (this.inputs.get(device.id) === shell) this.inputs.delete(device.id);
      await shell.close();
      throw error;
    }
  }
  private async inputShell(device: Device, authorize: () => void): Promise<AndroidInputShell> {
    const cached = this.inputs.get(device.id);
    if (cached) return cached;
    const pending = this.openingInputs.get(device.id);
    if (pending) return pending;
    const opening = (async () => {
      const serial = await this.serial(device);
      const { adb } = await this.resolve();
      authorize();
      if (this.closed) throw this.identityError();
      const shell = new AndroidInputShell({
        adb,
        serial,
        env: this.options.env,
        spawn: this.spawn,
        after:
          this.options.after ??
          ((ms, run) => {
            const timer = setTimeout(run, ms);
            return () => clearTimeout(timer);
          }),
      });
      this.inputs.set(device.id, shell);
      return shell;
    })();
    this.openingInputs.set(device.id, opening);
    try {
      return await opening;
    } finally {
      this.openingInputs.delete(device.id);
    }
  }
  /** Why a listed device that isn't booted can't be driven, and what the person does about it. */
  private unavailable(device: Device): DeviceError {
    const transport = this.transports.get(device.id);
    if (transport?.block) return blockedError(transport, device.name, this.options.platform);
    if (transport && transport.kind !== "emulator")
      return new DeviceError(
        "not_booted",
        `${device.name} is offline`,
        transport.kind === "network"
          ? "Check the device is on the same network with debugging on, then run adb connect HOST:PORT again."
          : "Unlock the device and check its USB cable, then refresh the device list.",
      );
    return new DeviceError(
      device.state === "unauthorized" ? "permission_denied" : "not_booted",
      "Android emulator is not available for input",
      "Boot the emulator and authorize adb before retrying.",
    );
  }
  /** Whether `id` is a phone or network device rather than an emulator. */
  physical(id: string): boolean {
    const kind = this.transports.get(id)?.kind;
    return kind === "usb" || kind === "network";
  }
  /** The device behind an adb serial, as its id names it: the AVD, or the hardware serial. */
  private async identity(adb: string, serial: string): Promise<string | undefined> {
    const kind = transportKind(serial);
    if (kind === "emulator") return this.emulatorName(adb, serial);
    const found = await this.hardwareOf(adb, serial);
    return physicalIdPart({ serial }, found?.serialno);
  }
  private async hardwareOf(adb: string, serial: string): Promise<DeviceHardware | undefined> {
    try {
      const { stdout } = await this.run(
        adb,
        ["-s", serial, "shell", "getprop ro.serialno; getprop ro.build.version.release"],
        4096,
        5000,
      );
      const [serialLine = "", releaseLine = ""] = stdout.split("\n");
      const serialno = hardwareSerial(serialLine);
      const release = /^[\w.]{1,16}$/.exec(releaseLine.trim())?.[0];
      return serialno ? { serialno, ...(release ? { release } : {}) } : undefined;
    } catch {
      // Listed under its adb serial until the property reads.
      return undefined;
    }
  }
  private identityError() {
    return new DeviceError(
      "not_found",
      "Android capture transport changed identity",
      "Refresh the device list and start capture again.",
    );
  }
  private async emulatorWindow(): Promise<boolean> {
    try {
      return (await this.options.emulatorWindow?.()) === true;
    } catch {
      return false;
    }
  }
  private async emulatorName(adb: string, serial: string): Promise<string | undefined> {
    for (const args of [
      ["shell", "getprop", "ro.boot.qemu.avd_name"],
      ["shell", "getprop", "ro.kernel.qemu.avd_name"],
      ["emu", "avd", "name"],
    ]) {
      try {
        const name = avdNameOrUndefined(
          (await this.run(adb, ["-s", serial, ...args], 4096, 3000)).stdout,
        );
        if (name) return name;
      } catch {
        // A transport can fail a property probe while the next naming source still works.
        // Inventory retains an unnamed serial if all sources fail; identity checks decide
        // whether it is safe to perform an operation on that device.
      }
    }
    return undefined;
  }
  private async verifyTransport(adb: string, device: Device, serial: string) {
    if ((await this.identity(adb, serial)) !== nativeId(device)) throw this.identityError();
  }
  async captureTransport(device: Device, expectedSerial?: string) {
    const serial = await this.serial(device);
    if (expectedSerial && serial !== expectedSerial) throw this.identityError();
    const { adb } = await this.resolve();
    // Dimensions and screenrecord must use this exact transport, never a second inventory lookup.
    await this.verifyTransport(adb, device, serial);
    const result = await this.run(adb, ["-s", serial, ...adbShell(["wm", "size"])], 4096);
    await this.verifyTransport(adb, device, serial);
    const orientation = await this.run(
      adb,
      ["-s", serial, ...adbShell(["dumpsys", "input"])],
      128 * 1024,
      3000,
    );
    const rawRotation = /SurfaceOrientation:\s*([0-3])/.exec(orientation.stdout)?.[1];
    const rotation =
      rawRotation === undefined
        ? z.coerce
            .number()
            .int()
            .min(0)
            .max(3)
            .parse(
              (
                await this.run(
                  adb,
                  ["-s", serial, ...adbShell(["settings", "get", "system", "user_rotation"])],
                  4096,
                  3000,
                )
              ).stdout.trim(),
            )
        : Number(rawRotation);
    await this.verifyTransport(adb, device, serial);
    const size = androidDimensions(result.stdout);
    return { adb, serial, ...(rotation % 2 ? { width: size.height, height: size.width } : size) };
  }
  /** One adb command on a capture's transport, refused once that serial names another AVD. */
  async transportCommand(
    device: Device,
    serial: string,
    args: readonly string[],
    maxBytes?: number,
    timeoutMs?: number,
  ) {
    const { adb } = await this.resolve();
    await this.verifyTransport(adb, device, serial);
    return this.run(adb, ["-s", serial, ...args], maxBytes, timeoutMs);
  }
  watchCaptureTransport(device: Device, serial: string, fail: (error: DeviceError) => void) {
    if (this.transportWatchers.size >= 4)
      throw new DeviceError(
        "limit",
        "Capture identity watcher limit",
        "Stop another device stream.",
      );
    const watcher = { id: device.id, serial, fail };
    this.transportWatchers.add(watcher);
    const current = this.inventory.get(device.id);
    if (current?.state !== "booted" || current.serial !== serial) fail(this.identityError());
    return () => {
      this.transportWatchers.delete(watcher);
    };
  }
  async uiDump(device: Device): Promise<string> {
    const serial = await this.serial(device);
    const { adb } = await this.resolve();
    if (this.uiHelpers) {
      try {
        await this.verifyTransport(adb, device, serial);
        const xml = await this.uiHelpers.tree(device.id, adb, serial);
        await this.verifyTransport(adb, device, serial);
        return xml;
      } catch {
        // The helper could not run on this image: uiautomator's own dump still can.
      }
    }
    const path = "/data/local/tmp/ace-ui.xml";
    const run = (args: readonly string[], maxBytes: number) =>
      this.run(adb, ["-s", serial, ...args], maxBytes);
    try {
      await this.verifyTransport(adb, device, serial);
      await run(adbShell(["uiautomator", "dump", path]), 8192);
      await this.verifyTransport(adb, device, serial);
      const result = await run(["exec-out", "cat", path], 1024 * 1024);
      await this.verifyTransport(adb, device, serial);
      return result.stdout;
    } finally {
      // Never delete a similarly named file on a replacement emulator.
      await this.verifyTransport(adb, device, serial);
      await run(adbShell(["rm", "-f", path]), 4096);
    }
  }
  async captureDimensions(device: Device): Promise<{ width: number; height: number }> {
    const { width, height } = await this.captureTransport(device);
    return { width, height };
  }

  async boot(input: Device, authorize?: () => void): Promise<void> {
    const device = await this.current(input);
    if (device.state === "booted") return;
    if (this.physical(device.id)) throw this.unavailable(device);
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
      if (!emulator)
        throw this.options.platform === "linux" && this.options.arch === "arm64"
          ? armEmulatorNote()
          : new DeviceError(
              "sdk_missing",
              "The Android Emulator was not found",
              "Install the Android Emulator from Android Studio's SDK Manager, then set ANDROID_HOME to the SDK directory.",
            );
      const window = await this.emulatorWindow();
      const used = new Set(
        adbTransports((await this.run(adb, ["devices", "-l"], 128 * 1024)).stdout).map(
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
          args: emulatorBootArgs({
            avd: nativeId(device),
            port,
            window,
            platform: this.options.platform,
            gpu: this.options.env["ACE_ANDROID_EMULATOR_GPU"],
          }),
          env: this.options.env,
          name: "device-emulator",
          maxLineBytes: 16 * 1024,
        });
      } catch (error) {
        this.ports.delete(port);
        throw error;
      }
      this.emulators.set(device.id, proc);
      this.ownedSerials.set(device.id, `emulator-${port}`);
      const controller = new AbortController();
      void proc.exited.then(() => {
        controller.abort();
        this.ports.delete(port);
        if (this.emulators.get(device.id) === proc) {
          this.emulators.delete(device.id);
          this.ownedSerials.delete(device.id);
        }
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
        await proc.stop({ graceMs: 30_000 });
        throw error;
      }
    } finally {
      this.pendingBoots.delete(device.id);
    }
  }
  async shutdown(device: Device, authorize?: () => void): Promise<void> {
    if (this.physical(device.id))
      throw new DeviceError(
        "not_supported",
        `ace doesn't power off ${device.name}`,
        "Use the device's own power button, or disconnect it.",
      );
    // Retain this process identity: another boot may replace the map entry while adb waits.
    const emulator = this.emulators.get(device.id);
    const serial = await this.serial(device);
    const { adb } = await this.resolve();
    await this.verifyTransport(adb, device, serial);
    authorize?.();
    try {
      await this.run(
        adb,
        ["-s", serial, "emu", "kill"],
        undefined,
        undefined,
        undefined,
        authorize,
      );
    } catch {
      // Emulator console unreachable or already dead; fall through to the wait below.
    }
    authorize?.();
    if (await this.transportGone(adb, serial)) {
      await this.waitForExit(emulator);
      this.serialNames.delete(serial);
      return;
    }
    // A lease or an emulator console port may have changed during the disconnect wait.
    // Fence both outside the best-effort command catch so either failure stops shutdown.
    await this.verifyTransport(adb, device, serial);
    authorize?.();
    try {
      await this.run(
        adb,
        ["-s", serial, "shell", "reboot", "-p"],
        4096,
        10_000,
        undefined,
        authorize,
      );
    } catch {
      // Power-off is best effort; the second wait decides the outcome.
    }
    if (await this.transportGone(adb, serial)) {
      await this.waitForExit(emulator);
      this.serialNames.delete(serial);
      return;
    }
    authorize?.();
    if (emulator) {
      await emulator.stop({ graceMs: 30_000 });
      if (await this.transportGone(adb, serial)) {
        this.serialNames.delete(serial);
        return;
      }
    }
    throw new DeviceError(
      "command_failed",
      "Emulator did not shut down",
      "Close the emulator window, then refresh the device list.",
    );
  }
  private async waitForExit(proc: SupervisedProcess | undefined): Promise<void> {
    if (!proc) return;
    let cancel: (() => void) | undefined;
    const after =
      this.options.after ??
      ((ms: number, run: () => void) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      });
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => {
        cancel = after(30_000, () => resolve(false));
      }),
    ]).finally(() => cancel?.());
    if (!exited) await proc.stop({ graceMs: 30_000 });
  }
  private async transportGone(adb: string, serial: string): Promise<boolean> {
    try {
      const result = await this.run(adb, ["-s", serial, "wait-for-any-disconnect"], 4096, 20_000);
      return result.code === 0;
    } catch {
      return false;
    }
  }
  async logs(device: Device): Promise<{ command: string; args: string[] }> {
    const serial = await this.serial(device);
    const { adb } = await this.resolve();
    return { command: adb, args: ["-s", serial, "logcat", "-v", "threadtime", "-T", "1"] };
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.emulators.entries()].map(async ([id, proc]) => {
        const serial = this.ownedSerials.get(id);
        if (serial) {
          try {
            const { adb } = await this.resolve();
            const result = await (this.options.probe ?? probeOutput)(
              adb,
              ["-s", serial, "emu", "kill"],
              { env: this.options.env, maxBytes: 4096, timeoutMs: 10_000 },
            );
            if (result.code !== 0) throw new Error("Emulator console shutdown failed");
            await this.waitForExit(proc);
            return;
          } catch {
            /* Fall back to a generous process shutdown window. */
          }
        }
        await proc.stop({ graceMs: 30_000 });
      }),
    );
    await Promise.all([...this.inputs.values()].map((shell) => shell.close()));
    await this.uiHelpers?.close();
    this.inputs.clear();
    this.emulators.clear();
    this.ownedSerials.clear();
    this.serialNames.clear();
    this.hardware.clear();
    this.transports.clear();
    this.inventory.clear();
    this.transportWatchers.clear();
    this.ports.clear();
  }
}
