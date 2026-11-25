// SPDX-License-Identifier: Apache-2.0
/**
 * Thin TypeScript shell over `ace-daemon-node`'s D2 device inventory bindings
 * (`ACE_DEVICE_INVENTORY=native`, requiring `ACE_SUPERVISOR=native`).
 * Importing this module never opens the addon; when the switch is on and the
 * addon is absent or outdated, the first call throws naming the path and never
 * falls back to TypeScript.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deviceInventoryBackend } from "@ace/provider-kit/native-switches";
import type { AppDevice as Device, DeviceFailure } from "@ace/protocol/devices";
import type { AdbTransport } from "./adb-transports.ts";
import type { AndroidInventory, DeviceHardware } from "./android-inventory.ts";
import { deviceFailure } from "./failure.ts";
import type { DeviceLog, Inventory } from "./inventory.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { DeviceError } from "./sdk.ts";
import { androidSdkRoots } from "./sdk-roots.ts";

export type InventoryReadScope = "all" | "adb" | "avds" | "ios";

interface NativeWatchHandle {
  current(): string | null;
  update(inventoryJson: string): string | null;
  setWatching(active: boolean, runtimeJson: string | null): string;
  timerFired(timerId: number): string;
  readSucceeded(readId: number, inventoryJson: string): string;
  readFailed(readId: number, failureJson: string, rawMessage: string): string;
  close(): string;
}

interface NativeWatchConstructor {
  new (configJson: string, onActions: (actionsJson: string) => void): NativeWatchHandle;
}

interface DeviceInventoryAddon {
  deviceAdbTransports(outputJson: string): string;
  deviceTransportKind(serialJson: string): string;
  devicePhysicalIdPart(inputJson: string): string;
  deviceHardwareSerial(outputJson: string): string | null;
  devicePhysicalName(transportJson: string): string;
  deviceBlockedError(inputJson: string): string;
  deviceAndroidInventory(inputJson: string): string;
  NativeInventoryWatch: NativeWatchConstructor;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

function addonPath(): string {
  const own = process.env.ACE_DEVICE_INVENTORY_ADDON;
  const [name, explicit] =
    own !== undefined
      ? (["ACE_DEVICE_INVENTORY_ADDON", own] as const)
      : (["ACE_STORE_ADDON", process.env.ACE_STORE_ADDON] as const);
  if (explicit === undefined)
    return fileURLToPath(
      new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
    );
  if (explicit === "") throw new Error(`${name} is set but empty`);
  return explicit;
}

function isAddon(
  exports: Record<string, unknown>,
): exports is Record<string, unknown> & DeviceInventoryAddon {
  return (
    typeof exports["deviceAdbTransports"] === "function" &&
    typeof exports["deviceTransportKind"] === "function" &&
    typeof exports["devicePhysicalIdPart"] === "function" &&
    typeof exports["deviceHardwareSerial"] === "function" &&
    typeof exports["devicePhysicalName"] === "function" &&
    typeof exports["deviceBlockedError"] === "function" &&
    typeof exports["deviceAndroidInventory"] === "function" &&
    typeof exports["NativeInventoryWatch"] === "function"
  );
}

let loaded: DeviceInventoryAddon | undefined;

function addon(): DeviceInventoryAddon {
  if (loaded) return loaded;
  if (deviceInventoryBackend() !== "native")
    throw new Error("Native device inventory is off: ACE_DEVICE_INVENTORY is not native");
  const path = addonPath();
  if (!existsSync(path))
    throw new Error(
      `ACE_DEVICE_INVENTORY=native needs the daemon addon at ${path}; build it with cargo build --release in native/daemon`,
    );
  const mod = { exports: {} as Record<string, unknown> };
  process.dlopen(mod, path);
  if (!isAddon(mod.exports))
    throw new Error(
      `The daemon addon at ${path} does not export D2 device inventory bindings; rebuild it with cargo build --release in native/daemon`,
    );
  loaded = mod.exports;
  return loaded;
}

function toDeviceError(failure: DeviceFailure): DeviceError {
  return new DeviceError(failure.code, failure.message, failure.hint);
}

export function nativeAdbTransports(output: string): AdbTransport[] {
  const raw = JSON.parse(addon().deviceAdbTransports(JSON.stringify(output))) as
    | { ok: true; transports: AdbTransport[] }
    | { ok: false; error: DeviceFailure };
  if (!raw.ok) throw toDeviceError(raw.error);
  return raw.transports;
}

export function nativeTransportKind(serial: string): AdbTransport["kind"] {
  return addon().deviceTransportKind(JSON.stringify(serial)) as AdbTransport["kind"];
}

export function nativePhysicalIdPart(
  transport: Pick<AdbTransport, "serial" | "usb">,
  hardware?: string,
): string {
  const payload = {
    serial: transport.serial,
    ...(transport.usb !== undefined ? { usb: transport.usb } : {}),
    ...(hardware !== undefined ? { hardware } : {}),
  };
  return JSON.parse(addon().devicePhysicalIdPart(JSON.stringify(payload))) as string;
}

export function nativeHardwareSerial(output: string): string | undefined {
  const raw = addon().deviceHardwareSerial(JSON.stringify(output));
  return raw === null ? undefined : (JSON.parse(raw) as string);
}

export function nativePhysicalName(transport: AdbTransport): string {
  return JSON.parse(addon().devicePhysicalName(JSON.stringify(transport))) as string;
}

export function nativeBlockedError(
  transport: Pick<AdbTransport, "kind" | "block">,
  name: string,
  platform: string,
): DeviceError {
  const payload = {
    kind: transport.kind,
    ...(transport.block !== undefined ? { block: transport.block } : {}),
    name,
    platform,
  };
  const failure = JSON.parse(addon().deviceBlockedError(JSON.stringify(payload))) as DeviceFailure;
  return toDeviceError(failure);
}

export function nativeAndroidInventory(input: {
  avds: readonly string[];
  emulators: readonly { serial: string; state: Device["state"]; name: string }[];
  physical: readonly AdbTransport[];
  hardware: ReadonlyMap<string, DeviceHardware>;
  platform: string;
}): AndroidInventory {
  const payload = {
    avds: input.avds,
    emulators: input.emulators,
    physical: input.physical,
    hardware: [...input.hardware.entries()].map(([serial, hw]) => ({
      serial,
      serialno: hw.serialno,
      release: hw.release ?? null,
    })),
    platform: input.platform,
  };
  const raw = JSON.parse(addon().deviceAndroidInventory(JSON.stringify(payload))) as {
    devices: Device[];
    transports: { id: string; kind: AdbTransport["kind"]; block?: AdbTransport["block"] }[];
    blocked: DeviceFailure[];
    duplicate: boolean;
  };
  const transports = new Map<string, Pick<AdbTransport, "kind" | "block">>();
  for (const entry of raw.transports) {
    transports.set(entry.id, {
      kind: entry.kind,
      ...(entry.block !== undefined ? { block: entry.block } : {}),
    });
  }
  return {
    devices: raw.devices,
    transports,
    blocked: raw.blocked.map(toDeviceError),
    duplicate: raw.duplicate,
  };
}

/** Synchronously checks whether `candidate` is an executable file. */
function executableFileSync(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Synchronously locates `adb` using the same SDK-root + PATH precedence as `findAndroidTools`. */
function findAdbSync(
  env: Readonly<Record<string, string | undefined>>,
  home: string | undefined,
): string | undefined {
  const names = process.platform === "win32" ? ["adb.exe", "adb.cmd", "adb"] : ["adb"];
  for (const root of androidSdkRoots(env, home)) {
    for (const name of names) {
      const candidate = join(root, "platform-tools", name);
      if (executableFileSync(candidate)) return candidate;
    }
  }
  const pathValue = env["PATH"] ?? (process.platform === "win32" ? env["Path"] : undefined);
  if (!pathValue) return undefined;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (executableFileSync(candidate)) return candidate;
    }
  }
  return undefined;
}

type CoordinatorJsAction =
  | { op: "arm_timer"; id: number; delayMs: number }
  | { op: "cancel_timer"; id: number }
  | { op: "start_read"; readId: number; scope: InventoryReadScope; liveness: boolean }
  | { op: "publish"; inventory: Inventory }
  | { op: "log_warn"; message: string; detail: string };

export interface NativeInventoryWatchConfig {
  platform: string;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface NativeInventoryWatchOptions {
  readSource(scope: InventoryReadScope, liveness: boolean): Promise<Inventory>;
  after: DeviceRuntime["after"];
  intervalMs: number;
  log?: DeviceLog | undefined;
  watchConfig: () => NativeInventoryWatchConfig;
}

function encodeRuntimeConfig(config: NativeInventoryWatchConfig): Record<string, unknown> {
  const envPairs: [string, string][] = [];
  for (const [k, v] of Object.entries(config.env)) {
    if (v !== undefined) envPairs.push([k, v]);
  }
  const adbPath = findAdbSync(config.env, config.home);
  return {
    home: config.home,
    env: envPairs,
    adbPath: adbPath ?? null,
  };
}

/**
 * Drop-in replacement for `InventoryWatch` backed by Rust's `NativeInventoryWatch`
 * (`host:track-devices-l`, `notify` on AVD & CoreSimulator folders, health state,
 * 4 s unhealthy fallback, and 60 s liveness reconcile).
 */
export class NativeDeviceInventoryWatch {
  private last: Inventory | undefined;
  private readonly listeners = new Set<(inventory: Inventory) => void>();
  private readonly timers = new Map<number, () => void>();
  private readonly handle: NativeWatchHandle;
  private readonly options: NativeInventoryWatchOptions;
  private active = false;
  private closed = false;

  constructor(options: NativeInventoryWatchOptions) {
    this.options = options;
    const initial = options.watchConfig();
    const ctor = addon().NativeInventoryWatch;
    this.handle = new ctor(
      JSON.stringify({
        enableIos: initial.platform === "darwin",
        fallbackIntervalMs: options.intervalMs,
        ...encodeRuntimeConfig(initial),
      }),
      (actionsJson) => {
        if (!this.closed) this.runActions(actionsJson);
      },
    );
  }

  current(): Inventory | undefined {
    return this.last;
  }

  update(inventory: Inventory): void {
    if (this.closed) return;
    const published = this.handle.update(JSON.stringify(inventory));
    if (published !== null) {
      this.publish(JSON.parse(published) as Inventory);
    }
  }

  watch(listener: (inventory: Inventory) => void): () => void {
    if (this.listeners.size >= 64) throw new Error("Device inventory subscriber limit (64)");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  poll(active: boolean): void {
    if (this.closed || active === this.active) return;
    this.active = active;
    if (active) {
      const runtimeJson = JSON.stringify(encodeRuntimeConfig(this.options.watchConfig()));
      this.runActions(this.handle.setWatching(true, runtimeJson));
    } else {
      this.runActions(this.handle.setWatching(false, null));
      this.clearAllTimers();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.active = false;
    this.runActions(this.handle.close());
    this.clearAllTimers();
    this.listeners.clear();
  }

  private clearAllTimers(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  private publish(inventory: Inventory): void {
    this.last = inventory;
    for (const listener of this.listeners) {
      try {
        listener(inventory);
      } catch {
        /* One subscriber cannot stop the others hearing about a change. */
      }
    }
  }

  private runActions(actionsJson: string): void {
    const actions = JSON.parse(actionsJson) as CoordinatorJsAction[];
    for (const action of actions) {
      switch (action.op) {
        case "arm_timer": {
          if (this.closed || !this.active) break;
          const prev = this.timers.get(action.id);
          prev?.();
          const cancel = this.options.after(action.delayMs, () => {
            this.timers.delete(action.id);
            if (this.closed || !this.active) return;
            this.runActions(this.handle.timerFired(action.id));
          });
          this.timers.set(action.id, cancel);
          break;
        }
        case "cancel_timer": {
          const cancel = this.timers.get(action.id);
          if (cancel) {
            this.timers.delete(action.id);
            cancel();
          }
          break;
        }
        case "start_read": {
          if (this.closed || !this.active) break;
          void this.options.readSource(action.scope, action.liveness).then(
            (inventory) => {
              if (this.closed) return;
              this.runActions(this.handle.readSucceeded(action.readId, JSON.stringify(inventory)));
            },
            (error: unknown) => {
              if (this.closed) return;
              const rawMessage = error instanceof Error ? error.message : "Device inventory failed";
              const failure = deviceFailure(error);
              this.runActions(
                this.handle.readFailed(action.readId, JSON.stringify(failure), rawMessage),
              );
            },
          );
          break;
        }
        case "publish": {
          this.publish(action.inventory);
          break;
        }
        case "log_warn": {
          this.options.log?.("warn", action.message, { message: action.detail });
          break;
        }
      }
    }
  }
}
