import { open, realpath, stat } from "node:fs/promises";
import { sep } from "node:path";

/**
 * Coarsest timestamp a filesystem may keep (FAT keeps modification times to 2 s). A file
 * written this recently can change again without moving its times.
 */
const timestampSlackMs = 2000n;
/** Mach-O (thin and fat), ELF and PE executables start with one of these. */
const nativeHeaders = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0x7f, 0x45, 0x4c, 0x46],
  [0x4d, 0x5a],
];

/**
 * What each installed Claude CLI reported for `--version`, so a session open does not start the
 * CLI only to read it again.
 *
 * Only a direct installation is remembered: a native executable whose resolved path names the
 * version it reported, as the native installer (`…/versions/<version>`) and the Homebrew cask
 * (`…/<version>/claude`) lay it out. Anything else (a script, a version manager's shim, a
 * wrapper) can start a different CLI without changing itself, and is asked every time. A
 * remembered entry is read again once the path resolves elsewhere or the file's device, inode,
 * size, modification or change time moves.
 */
export class CliVersions {
  #known = new Map<string, { file: string; output: string }>();
  #now: () => number;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async read(executable: string, probe: () => Promise<string>): Promise<string> {
    const resolved = await realpath(executable);
    const before = await fileIdentity(resolved);
    const known = this.#known.get(resolved);
    if (known && known.file === before.file) return known.output;
    this.#known.delete(resolved);
    const started = BigInt(Math.floor(this.#now()));
    const output = await probe();
    if (
      before.settled(started) &&
      versionNamedBy(resolved, output) &&
      (await realpath(executable)) === resolved &&
      (await fileIdentity(resolved)).file === before.file &&
      (await nativeExecutable(resolved))
    ) {
      if (this.#known.size >= 32) this.#known.clear();
      this.#known.set(resolved, { file: before.file, output });
    }
    return output;
  }
}

const settledTime = (time: bigint, started: bigint) =>
  time / 1_000_000n + timestampSlackMs < started;
async function fileIdentity(path: string) {
  const info = await stat(path, { bigint: true });
  return {
    file: [info.isFile(), info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":"),
    settled: (started: bigint) =>
      info.isFile() && settledTime(info.mtimeNs, started) && settledTime(info.ctimeNs, started),
  };
}
/** The reported version is one of the resolved path's own segments. */
function versionNamedBy(path: string, output: string): boolean {
  const version = /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1];
  return version !== undefined && path.split(sep).includes(version);
}
async function nativeExecutable(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(4), 0, 4, 0);
    return nativeHeaders.some(
      (header) => bytesRead >= header.length && header.every((byte, at) => buffer[at] === byte),
    );
  } finally {
    await file.close();
  }
}
