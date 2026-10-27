import { closeSync, openSync, readSync } from "node:fs";

/*
 * Windows ARM64 runs an x64 Chrome (ace's last-resort Chrome for Testing) under Windows' x64
 * emulation. Its renderers crash under Chrome's renderer code integrity guard, whose check of
 * loaded code conflicts with the emulator (2 to 4 crashes in 12 page loads on the ARM64 VM, none
 * without it). That browser alone, and nothing native, runs with the guard off.
 */

export const emulatedChromeFlag = "--disable-features=RendererCodeIntegrity";

/** The CPU a Windows executable is built for, from its PE header; undefined if unreadable. */
export function executableMachine(path: string): "x64" | "arm64" | "x86" | undefined {
  let file: number | undefined;
  try {
    file = openSync(path, "r");
    const header = Buffer.alloc(4096);
    readSync(file, header, 0, header.length, 0);
    if (header.readUInt16LE(0) !== 0x5a4d) return undefined;
    const pe = header.readUInt32LE(0x3c);
    if (pe + 6 > header.length || header.readUInt32LE(pe) !== 0x4550) return undefined;
    const machine = header.readUInt16LE(pe + 4);
    return machine === 0x8664
      ? "x64"
      : machine === 0xaa64
        ? "arm64"
        : machine === 0x14c
          ? "x86"
          : undefined;
  } catch {
    return undefined;
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

/** A Chrome launch's flags: an x64 Chrome on an ARM64 machine gets `emulatedChromeFlag`, once. */
export function emulatedChromeArgs(
  executable: string,
  args: readonly string[],
  hostArch: string,
  machine: (path: string) => string | undefined = executableMachine,
): readonly string[] {
  if (hostArch !== "arm64" || args.includes(emulatedChromeFlag)) return args;
  return machine(executable) === "x64" ? [...args, emulatedChromeFlag] : args;
}
