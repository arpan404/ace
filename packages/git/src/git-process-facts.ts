import { createRequire } from "node:module";
import type koffiModule from "koffi";
import { z } from "zod";

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

/** Raw Win32 surface. Tests may inject a fake; production uses koffi. */
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
  const koffi: typeof koffiModule = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll");
  let ntdll: ReturnType<typeof koffi.load> | undefined;
  const unload = () => {
    try {
      kernel.unload();
    } finally {
      ntdll?.unload();
    }
  };
  try {
    ntdll = koffi.load("ntdll.dll");
    const open = kernel.func("void* __stdcall OpenProcess(uint access, int inherit, uint pid)");
    const close = kernel.func("int __stdcall CloseHandle(void* handle)");
    const read = kernel.func(
      "int __stdcall ReadProcessMemory(void* process, uint64_t base, _Out_ void* buffer, uint64_t size, void* done)",
    );
    const wow64 = kernel.func("int __stdcall IsWow64Process(void* process, _Out_ int* wow64)");
    const query = ntdll.func(
      "int __stdcall NtQueryInformationProcess(void* process, int infoClass, _Out_ void* info, uint length, _Out_ uint* returned)",
    );
    return {
      open: (pid, access) => open(access, 0, pid),
      close: (handle) => void close(handle),
      query: (handle, infoClass, info, returned) =>
        integer.parse(query(handle, infoClass, info, info.length, returned)),
      read: (handle, address, into) =>
        integer.parse(read(handle, address, into, BigInt(into.length), null)) !== 0,
      wow64(handle) {
        const out = [0];
        if (integer.parse(wow64(handle, out)) === 0) return undefined;
        return out[0] !== 0;
      },
      unload,
    };
  } catch (error) {
    try {
      unload();
    } catch {
      /* Keep the binding error. */
    }
    throw error;
  }
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
