import { z } from "zod";
import { nativePointer, openLibrary, type NativeLibrary } from "@ace/provider-kit/bun-ffi";

/**
 * What Windows tells about a running Git process beyond its name: its command line and its
 * working directory. Either is absent when the process can't be read (another account's, an
 * elevated one, a 32-bit one), and a reader then treats it as possibly working anywhere.
 *
 * The command line comes from NtQueryInformationProcess(ProcessCommandLineInformation), which
 * needs only limited query access. The working directory lives in the process's own parameter
 * block: ProcessBasicInformation gives its PEB, whose ProcessParameters (offset 0x20) hold
 * CurrentDirectory.DosPath at 0x38 as a UNICODE_STRING, read with ReadProcessMemory. Sources:
 * NtQueryInformationProcess, PROCESS_BASIC_INFORMATION, PEB, RTL_USER_PROCESS_PARAMETERS and
 * ReadProcessMemory on learn.microsoft.com; the 64-bit layout is the same on x64 and ARM64.
 *
 * Loaded only on Windows (see `scanGitProcesses`).
 */
export interface GitProcessFacts {
  commandLine?: string | undefined;
  cwd?: string | undefined;
}

/** Raw Win32 surface. Tests may inject a fake; production uses bun:ffi. */
export interface ProcessFactsApi {
  open(pid: number, access: number): unknown;
  close(handle: unknown): void;
  /** NTSTATUS, 0 on success; `returned[0]` receives the bytes written. */
  query(handle: unknown, infoClass: number, info: Buffer, returned: number[]): number;
  read(handle: unknown, address: bigint, into: Buffer): boolean;
  /** Whether the process runs under WOW64 (32-bit on 64-bit Windows); undefined when unknown. */
  wow64(handle: unknown): boolean | undefined;
  unload(): void;
}

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const ProcessBasicInformation = 0;
const ProcessCommandLineInformation = 60;
const integer = z.number().int();

function loadProcessFactsApi(): ProcessFactsApi {
  const kernel = openLibrary("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    ReadProcessMemory: { args: ["ptr", "u64", "ptr", "u64", "ptr"], returns: "i32" },
    IsWow64Process: { args: ["ptr", "ptr"], returns: "i32" },
  });
  let ntdll: NativeLibrary<"NtQueryInformationProcess">;
  try {
    ntdll = openLibrary("ntdll.dll", {
      NtQueryInformationProcess: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    });
  } catch (error) {
    kernel.close();
    throw error;
  }
  const k = kernel.symbols;
  return {
    open: (pid, access) => k.OpenProcess(access, 0, pid),
    close: (handle) => void k.CloseHandle(nativePointer(handle)),
    query(handle, infoClass, info, returned) {
      const written = new Uint32Array(1);
      const status = integer.parse(
        ntdll.symbols.NtQueryInformationProcess(
          nativePointer(handle),
          infoClass,
          info,
          info.length,
          written,
        ),
      );
      returned[0] = written[0] ?? 0;
      return status;
    },
    read: (handle, address, into) =>
      integer.parse(
        k.ReadProcessMemory(nativePointer(handle), address, into, BigInt(into.length), null),
      ) !== 0,
    wow64(handle) {
      const out = new Int32Array(1);
      if (integer.parse(k.IsWow64Process(nativePointer(handle), out)) === 0) return undefined;
      return out[0] !== 0;
    },
    unload: () => {
      try {
        kernel.close();
      } finally {
        ntdll.close();
      }
    },
  };
}

const isNull = (handle: unknown) =>
  handle === null || handle === undefined || handle === 0 || handle === 0n;

/** UNICODE_STRING on 64-bit Windows: Length (bytes) at 0, the buffer pointer at 8. */
const unicodeHeaderBytes = 16;

function commandLine(api: ProcessFactsApi, handle: unknown, buffer: Buffer): string | undefined {
  const returned = [0];
  if (api.query(handle, ProcessCommandLineInformation, buffer, returned) !== 0) return;
  // The string follows its header in the same output buffer.
  const length = buffer.readUInt16LE(0);
  if (length % 2 || unicodeHeaderBytes + length > Math.min(buffer.length, returned[0] ?? 0)) return;
  return buffer.toString("utf16le", unicodeHeaderBytes, unicodeHeaderBytes + length);
}

function workingDirectory(api: ProcessFactsApi, handle: unknown): string | undefined {
  // A 32-bit process keeps its directory in its own 32-bit block.
  if (api.wow64(handle) !== false) return;
  const basic = Buffer.alloc(48);
  if (api.query(handle, ProcessBasicInformation, basic, [0]) !== 0) return;
  const peb = basic.readBigUInt64LE(8);
  const pointer = Buffer.alloc(8);
  if (!peb || !api.read(handle, peb + 0x20n, pointer)) return;
  const parameters = pointer.readBigUInt64LE(0);
  const header = Buffer.alloc(unicodeHeaderBytes);
  if (!parameters || !api.read(handle, parameters + 0x38n, header)) return;
  const length = header.readUInt16LE(0);
  const address = header.readBigUInt64LE(8);
  if (!length || length % 2 || !address) return;
  const text = Buffer.alloc(length);
  if (!api.read(handle, address, text)) return;
  const path = text.toString("utf16le");
  // Anything but an absolute drive or UNC path is a torn or foreign read: unknown.
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\])/.test(path) || path.includes("\0")) return;
  // Windows keeps the directory with a trailing separator; a drive root keeps its own.
  return /^[A-Za-z]:\\$/.test(path) ? path : path.replace(/\\+$/, "");
}

function factsOf(api: ProcessFactsApi, pid: number, buffer: Buffer): GitProcessFacts {
  let handle = api.open(pid, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ);
  const full = !isNull(handle);
  if (!full) handle = api.open(pid, PROCESS_QUERY_LIMITED_INFORMATION);
  if (isNull(handle)) return {};
  try {
    const facts: GitProcessFacts = {};
    try {
      facts.commandLine = commandLine(api, handle, buffer);
    } catch {
      /* Unknown. */
    }
    try {
      if (full && process.arch !== "ia32" && process.arch !== "arm")
        facts.cwd = workingDirectory(api, handle);
    } catch {
      /* Unknown. */
    }
    return facts;
  } finally {
    api.close(handle);
  }
}

/** Facts for each of `pids`; an empty map when Windows' process API can't be loaded at all. */
export function gitProcessFacts(
  pids: readonly number[],
  load: () => ProcessFactsApi = loadProcessFactsApi,
): Map<number, GitProcessFacts> {
  const result = new Map<number, GitProcessFacts>();
  if (!pids.length) return result;
  let api: ProcessFactsApi;
  try {
    api = load();
  } catch {
    return result;
  }
  try {
    // A command line is at most 32,767 UTF-16 units.
    const buffer = Buffer.alloc(unicodeHeaderBytes + 65_536);
    for (const pid of pids) result.set(pid, factsOf(api, pid, buffer));
  } finally {
    try {
      api.unload();
    } catch {
      /* Nothing more to release. */
    }
  }
  return result;
}
