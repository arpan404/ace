import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where running emulators describe themselves (`pid_<pid>.ini`): the emulator's own discovery
 * directory, by host OS.
 */
export function emulatorRunningDirectory(input: {
  platform: string;
  home: string;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  if (input.platform === "darwin")
    return join(input.home, "Library", "Caches", "TemporaryItems", "avd", "running");
  if (input.platform === "win32") {
    const local = input.env["LOCALAPPDATA"];
    return local ? join(local, "Temp", "avd", "running") : undefined;
  }
  if (input.platform === "linux") {
    const runtime = input.env["XDG_RUNTIME_DIR"];
    return runtime
      ? join(runtime, "avd", "running")
      : join("/tmp", `android-${input.env["USER"] ?? "unknown"}`, "avd", "running");
  }
  return undefined;
}

/** An emulator's gRPC endpoint, when it serves one ace can use (localhost, token auth). */
export interface EmulatorGrpc {
  port: number;
  token: string;
}

/** One discovery file's `key=value` lines. */
export function discoveryEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) entries.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return entries;
}

/**
 * The gRPC endpoint of the emulator listening on console port `consolePort`, from its discovery
 * file. An emulator without gRPC, or one using the JWT authentication Android Studio's
 * emulators default to, has none ace can use: its video then comes from scrcpy.
 */
export async function emulatorGrpc(
  directory: string | undefined,
  consolePort: number,
): Promise<EmulatorGrpc | undefined> {
  if (!directory) return undefined;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!/^pid_\d+\.ini$/.test(name)) continue;
    let entries: Map<string, string>;
    try {
      entries = discoveryEntries(await readFile(join(directory, name), "utf8"));
    } catch {
      continue;
    }
    if (Number(entries.get("port.serial")) !== consolePort) continue;
    const port = Number(entries.get("grpc.port"));
    const token = entries.get("grpc.token");
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) return undefined;
    return { port, token };
  }
  return undefined;
}

/** `emulator-5554` → 5554; another serial isn't an emulator ace can reach this way. */
export function emulatorConsolePort(serial: string): number | undefined {
  const match = /^emulator-(\d{4,5})$/.exec(serial);
  return match ? Number(match[1]) : undefined;
}
