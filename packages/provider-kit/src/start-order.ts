import { readFileSync } from "node:fs";

/*
 * Kernel start times as an order. macOS records a process's start as wall-clock `sec:usec`;
 * Linux as `<boot id>:<ticks since boot>` (USER_HZ, 100 on every mainstream kernel). A cutoff
 * is "now" in the same units, so a start can be said to come before it.
 */
export type StartOrder = {
  /** Now, in start units; undefined when it can't be read here. */
  now(): bigint | undefined;
  /** The start's position in the same units; undefined when it doesn't parse. */
  position(start: string): bigint | undefined;
};

const ticksPerSecond = 100n;

function afterColon(start: string): string | undefined {
  const index = start.lastIndexOf(":");
  return index < 0 ? undefined : start.slice(index + 1);
}

export const darwinStartOrder: StartOrder = {
  now: () => BigInt(Date.now()) * 1000n,
  position(start) {
    const [sec, usec] = start.split(":");
    if (!sec || !usec || !/^\d+$/.test(sec) || !/^\d+$/.test(usec)) return undefined;
    return BigInt(sec) * 1_000_000n + BigInt(usec);
  },
};

export const linuxStartOrder: StartOrder = {
  now() {
    try {
      const uptime = readFileSync("/proc/uptime", "utf8").split(" ")[0] ?? "";
      const [whole, fraction = "0"] = uptime.split(".");
      if (!whole || !/^\d+$/.test(whole) || !/^\d+$/.test(fraction)) return undefined;
      const hundredths = BigInt(`${fraction}00`.slice(0, 2));
      return BigInt(whole) * ticksPerSecond + hundredths;
    } catch {
      return undefined;
    }
  },
  position(start) {
    const ticks = afterColon(start);
    return ticks && /^\d+$/.test(ticks) ? BigInt(ticks) : undefined;
  },
};

/** No order: nothing is ever "before" a cutoff. */
export const noStartOrder: StartOrder = { now: () => undefined, position: () => undefined };

export function systemStartOrder(platform: NodeJS.Platform = process.platform): StartOrder {
  if (platform === "darwin") return darwinStartOrder;
  if (platform === "linux") return linuxStartOrder;
  return noStartOrder;
}
