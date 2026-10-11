import type { AppDevice as Device, DeviceFailure } from "@ace/protocol/devices";
import { deviceFailure } from "./failure.ts";
import type { DeviceRuntime } from "./runtime.ts";

/** Where device failures go: the daemon's redacting log. */
export type DeviceLog = (
  level: "info" | "warn" | "error",
  message: string,
  fields: Readonly<Record<string, string | number | undefined>>,
) => void;

export type Inventory = { devices: Device[]; issues: DeviceFailure[] };

export function sameDevice(a: Device, b: Device): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.state === b.state &&
    a.runtime === b.runtime &&
    a.serial === b.serial
  );
}

function sameInventory(a: Inventory, b: Inventory): boolean {
  return (
    a.devices.length === b.devices.length &&
    a.devices.every((device, index) => {
      const other = b.devices[index];
      return other !== undefined && sameDevice(device, other);
    }) &&
    a.issues.length === b.issues.length &&
    a.issues.every((issue, index) => issue.message === b.issues[index]?.message)
  );
}

export interface InventoryWatchOptions {
  read(): Promise<unknown>;
  after: DeviceRuntime["after"];
  intervalMs: number;
  log?: DeviceLog | undefined;
}

/**
 * The last inventory read and who wants to hear when it changes. While anyone watches, it is
 * read again every `intervalMs`, so a simulator booted or shut down outside ace (from Xcode,
 * Simulator's menu or `simctl`) shows up without a manual refresh. Nothing polls when nobody
 * is watching.
 */
export class InventoryWatch {
  private last: Inventory | undefined;
  private readonly listeners = new Set<(inventory: Inventory) => void>();
  private cancel: (() => void) | undefined;
  private active = false;
  private lastFailure = "";
  private readonly options: InventoryWatchOptions;
  constructor(options: InventoryWatchOptions) {
    this.options = options;
  }
  /** Record a fresh read; listeners hear about it only when something changed. */
  update(inventory: Inventory): void {
    if (this.last && sameInventory(this.last, inventory)) return;
    this.last = inventory;
    for (const listener of this.listeners) {
      try {
        listener(inventory);
      } catch {
        /* One subscriber cannot stop the others hearing about a change. */
      }
    }
  }
  watch(listener: (inventory: Inventory) => void): () => void {
    if (this.listeners.size >= 64) throw new Error("Device inventory subscriber limit (64)");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Poll while `active`; stopping cancels the next read. */
  poll(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) this.schedule();
    else {
      this.cancel?.();
      this.cancel = undefined;
    }
  }
  private schedule(): void {
    this.cancel = this.options.after(this.options.intervalMs, () => {
      this.cancel = undefined;
      if (!this.active) return;
      void this.options
        .read()
        .then(
          () => {
            this.lastFailure = "";
          },
          (error: unknown) => {
            // Say once when reading starts failing, not every few seconds.
            const message = error instanceof Error ? error.message : "Device inventory failed";
            if (message !== this.lastFailure)
              this.options.log?.("warn", "Device inventory read failed", { message });
            this.lastFailure = message;
            this.update({ devices: this.last?.devices ?? [], issues: [deviceFailure(error)] });
          },
        )
        .finally(() => {
          if (this.active && !this.cancel) this.schedule();
        });
    });
  }
}
