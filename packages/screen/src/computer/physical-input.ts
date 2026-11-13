import type { PhysicalInput } from "../cowork.ts";
import { ComputerApps } from "./wire.ts";

/*
 * The person's own keyboard and mouse on this Mac (ADR 0143). macOS keeps the time since the
 * last HID event in the IOHIDSystem registry entry (`HIDIdleTime`, nanoseconds); reading it
 * needs no permission. Only when that is recent is the frontmost app asked for, so most agent
 * actions cost one small `ioreg` run and nothing else.
 */

/** The idle time `ioreg -c IOHIDSystem` reports, in ms; undefined if the output has none. */
export function hidIdleMs(ioreg: string): number | undefined {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg);
  if (!match?.[1]) return undefined;
  return Number(BigInt(match[1]) / 1_000_000n);
}

/** The frontmost app among those the computer-use helper lists, if it says. */
export function frontmostApp(apps: unknown): string | undefined {
  const parsed = ComputerApps.safeParse(apps);
  return parsed.success ? parsed.data.apps.find((app) => app.active)?.bundleId : undefined;
}

export interface MacPhysicalInputPorts {
  now(): number;
  /** Runs `ioreg` with these arguments and returns its output. */
  ioreg(args: readonly string[]): Promise<string>;
  /** The computer-use helper's `apps` reply, or undefined while there is no helper. */
  apps(): Promise<unknown>;
}

export function macPhysicalInput(ports: MacPhysicalInputPorts): PhysicalInput {
  return {
    async lastInputAt() {
      const idle = hidIdleMs(await ports.ioreg(["-c", "IOHIDSystem", "-d", "4", "-r"]));
      return idle === undefined ? undefined : ports.now() - idle;
    },
    async frontmost() {
      return frontmostApp(await ports.apps());
    },
  };
}
