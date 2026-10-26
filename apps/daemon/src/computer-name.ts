import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

/** Where the OS keeps the name the person gave this computer. Injected for tests. */
export type NameHost = {
  platform: NodeJS.Platform;
  /** macOS: `scutil --get ComputerName`, empty when unavailable. */
  macName(): Promise<string>;
  /** Linux: `/etc/machine-info`, where GNOME Settings › Device Name and hostnamectl keep it. */
  machineInfo(): Promise<string | undefined>;
  hostname(): string;
};

const systemHost: NameHost = {
  platform: process.platform,
  macName: () =>
    new Promise<string>((resolve) => {
      execFile(
        "/usr/sbin/scutil",
        ["--get", "ComputerName"],
        { timeout: 2000, maxBuffer: 4096 },
        (error, stdout) => resolve(error ? "" : stdout.trim()),
      );
    }),
  machineInfo: () => readFile("/etc/machine-info", "utf8").catch(() => undefined),
  hostname,
};

/**
 * `PRETTY_HOSTNAME` from machine-info: an environment-style file whose values may be quoted
 * as a shell would ("…" with backslash escapes, or '…').
 */
export function prettyHostname(machineInfo: string): string | undefined {
  for (const line of machineInfo.split("\n")) {
    const match = /^\s*PRETTY_HOSTNAME=(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[1] ?? "").trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
      value = value.slice(1, -1);
    return value.trim() || undefined;
  }
  return undefined;
}

/** Read the OS name once per server, with bounded output and a plain fallback. */
export async function computerName(host: NameHost = systemHost): Promise<string> {
  const named =
    host.platform === "darwin"
      ? await host.macName()
      : host.platform === "linux"
        ? prettyHostname((await host.machineInfo()) ?? "")
        : undefined;
  if (named && named.length <= 256) return named;
  return (
    host
      .hostname()
      .replace(/\.local$/i, "")
      .replace(/-/g, " ") || "This machine"
  );
}
