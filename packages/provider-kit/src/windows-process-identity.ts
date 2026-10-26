import { createRequire } from "node:module";
import type koffiModule from "koffi";
import { z } from "zod";

/**
 * Kernel process identity on Windows.
 *
 * OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION followed by
 * GetProcessTimes is the documented start surface:
 * https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess
 * https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
 * The creation time is a FILETIME
 * (https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ns-minwinbase-filetime):
 * a 64-bit count of 100-nanosecond intervals since 1 January 1601 UTC,
 * stored as dwLowDateTime followed by dwHighDateTime. PID plus creation
 * time disambiguates PID reuse. GetProcessTimes documents four [out]
 * FILETIME pointers with no NULL allowance, so all four buffers are real.
 *
 * FILETIME is wall-clock, not a boot counter. The wall-clock origin survives
 * reboots without a boot-id join, but a system-clock rollback can reuse a
 * start value and the clock resolution is coarse. Identity therefore assumes
 * a monotonic system clock; callers still prove absence separately (ESRCH)
 * and permission failures must retain resources. No reboot-proof claim is
 * made here.
 *
 * Owner equality uses the process token user SID, kept lossless as a string:
 * https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken
 * https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation
 * https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class
 * https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_user
 * https://learn.microsoft.com/en-us/windows/win32/api/sddl/nf-sddl-convertsidtostringsidw
 * https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-localfree
 * SID string notation is S-R-I-S...:
 * https://learn.microsoft.com/en-us/windows/win32/secauthz/sid-components
 * No hashes or synthetic uid values are used. Windows has no POSIX pgid;
 * group stays pid for leader checks. Process groups and inventory recovery
 * remain POSIX-only pending W11; this module never claims full recovery.
 */

/** Minimal right that still serves GetProcessTimes and OpenProcessToken (Vista+). */
export const processQueryLimitedInformation = 0x1000;
/** TOKEN_QUERY from winnt.h; required to query a token per GetTokenInformation docs. */
export const tokenQuery = 0x0008;
/** TokenUser from TOKEN_INFORMATION_CLASS per Microsoft docs. */
export const tokenUser = 1;
/** OpenProcess reports this when the PID names no live process. */
export const errorInvalidParameter = 87;
/** First GetTokenInformation with zero length reports this with the needed size. */
export const errorInsufficientBuffer = 122;

/** SID string in S-R-I-S... notation, kept lossless with a bounded length. */
export const windowsSidSchema = z
  .string()
  .regex(/^S-\d+(-\d+)+$/)
  .max(256);

const pidSchema = z.number().int().positive();
const dwordSchema = z.number().int().nonnegative().max(0xffffffff);
const nativeIntSchema = z.number().int();
const tokenInfoSizeSchema = z.number().int().positive().max(4096);

/** NULL from Win32 arrives as null, undefined, 0, or 0n through koffi BigInt pointers. */
function isNullHandle(handle: unknown): boolean {
  return handle === null || handle === undefined || handle === 0 || handle === 0n;
}

/** Raw Win32 surface behind the identity. Tests inject a fake; production uses koffi. */
export type WindowsProcessIdentityApi = {
  open: (pid: number) => unknown;
  times: (handle: unknown, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer) => number;
  openToken: (processHandle: unknown, outToken: unknown[]) => number;
  tokenInfo: (token: unknown, info: Buffer | null, length: number, needed: number[]) => number;
  sidToString: (sid: unknown, outString: unknown[]) => number;
  decodeSid: (ptr: unknown) => string;
  free: (ptr: unknown) => void;
  close: (handle: unknown) => void;
  lastError: () => number;
  unload: () => void;
};

/** Thin koffi shell over kernel32 and Advapi32; every native result is validated before use. */
export function loadWindowsProcessIdentityApi(): WindowsProcessIdentityApi {
  const koffi: typeof koffiModule = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll");
  let advapi: ReturnType<typeof koffi.load> | undefined;
  const unloadLibraries = (): void => {
    try {
      kernel.unload();
    } finally {
      advapi?.unload();
    }
  };
  try {
    advapi = koffi.load("Advapi32.dll");
    const openProcess = kernel.func(
      "void* __stdcall OpenProcess(uint access, int inherit, uint pid)",
    );
    const getProcessTimes = kernel.func(
      "int __stdcall GetProcessTimes(void* hProcess, void* lpCreationTime, void* lpExitTime, void* lpKernelTime, void* lpUserTime)",
    );
    const getLastError = kernel.func("uint __stdcall GetLastError()");
    const closeHandle = kernel.func("int __stdcall CloseHandle(void* handle)");
    const localFree = kernel.func("void* __stdcall LocalFree(void* hMem)");
    const openProcessToken = advapi.func(
      "int __stdcall OpenProcessToken(void* ProcessHandle, uint DesiredAccess, _Out_ void** TokenHandle)",
    );
    const getTokenInformation = advapi.func(
      "int __stdcall GetTokenInformation(void* TokenHandle, int TokenInformationClass, void* TokenInformation, uint TokenInformationLength, _Out_ uint* ReturnLength)",
    );
    const convertSidToStringSidW = advapi.func(
      "int __stdcall ConvertSidToStringSidW(void* Sid, _Out_ void** StringSid)",
    );
    return {
      open: (pid) => openProcess(processQueryLimitedInformation, 0, pid),
      times: (handle, creation, exit, kernelTime, userTime) =>
        getProcessTimes(handle, creation, exit, kernelTime, userTime),
      openToken: (processHandle, outToken) => openProcessToken(processHandle, tokenQuery, outToken),
      tokenInfo: (token, info, length, needed) =>
        getTokenInformation(token, tokenUser, info, length, needed),
      sidToString: (sid, outString) => convertSidToStringSidW(sid, outString),
      decodeSid: (ptr) => {
        const address = z.bigint().parse(ptr);
        const text: unknown = koffi.decode.string16(address);
        return z.string().min(1).parse(text);
      },
      free: (ptr) => {
        localFree(ptr);
      },
      lastError: () => getLastError(),
      close: (handle) => {
        closeHandle(handle);
      },
      unload: unloadLibraries,
    };
  } catch (error) {
    try {
      unloadLibraries();
    } catch {
      // Best-effort cleanup; preserve the original binding failure.
    }
    throw error;
  }
}

/** Combine a FILETIME pair into its canonical decimal start string. */
export function filetimeToStart(low: number, high: number): string {
  const lowWord = dwordSchema.parse(low);
  const highWord = dwordSchema.parse(high);
  return ((BigInt(highWord) << 32n) | BigInt(lowWord)).toString();
}

/**
 * Read the creation-time start and token-user SID for one PID. Returns
 * undefined only when OpenProcess reports ERROR_INVALID_PARAMETER (no such
 * process); every other native failure throws so the caller can prove
 * absence separately. The process handle, token handle, and SID string
 * buffer are always released before returning.
 */
export function readWindowsProcessIdentity(
  pid: number,
  api: WindowsProcessIdentityApi,
): { start: string; owner: string } | undefined {
  pidSchema.parse(pid);
  const handle = api.open(pid);
  if (isNullHandle(handle)) {
    if (nativeIntSchema.parse(api.lastError()) === errorInvalidParameter) return undefined;
    throw new Error("Kernel process identity unavailable");
  }
  try {
    const creation = Buffer.alloc(8);
    const exit = Buffer.alloc(8);
    const kernelTime = Buffer.alloc(8);
    const userTime = Buffer.alloc(8);
    if (nativeIntSchema.parse(api.times(handle, creation, exit, kernelTime, userTime)) === 0)
      throw new Error("Kernel process identity unavailable");
    const start = filetimeToStart(creation.readUInt32LE(0), creation.readUInt32LE(4));
    const tokenOut: unknown[] = [null];
    if (nativeIntSchema.parse(api.openToken(handle, tokenOut)) === 0)
      throw new Error("Kernel process identity unavailable");
    const token = tokenOut[0];
    if (isNullHandle(token)) throw new Error("Kernel process identity unavailable");
    try {
      const needed: number[] = [0];
      const first = nativeIntSchema.parse(api.tokenInfo(token, null, 0, needed));
      if (first !== 0) throw new Error("Kernel process identity unavailable");
      if (nativeIntSchema.parse(api.lastError()) !== errorInsufficientBuffer)
        throw new Error("Kernel process identity unavailable");
      const size = tokenInfoSizeSchema.parse(needed[0]);
      const info = Buffer.alloc(size);
      const actual: number[] = [0];
      if (nativeIntSchema.parse(api.tokenInfo(token, info, info.length, actual)) === 0)
        throw new Error("Kernel process identity unavailable");
      const sid: unknown =
        process.arch === "ia32" ? BigInt(info.readUInt32LE(0)) : info.readBigUInt64LE(0);
      if (sid === 0n) throw new Error("Kernel process identity unavailable");
      const stringOut: unknown[] = [null];
      if (nativeIntSchema.parse(api.sidToString(sid, stringOut)) === 0)
        throw new Error("Kernel process identity unavailable");
      const stringPtr = stringOut[0];
      if (isNullHandle(stringPtr)) throw new Error("Kernel process identity unavailable");
      try {
        const owner = windowsSidSchema.parse(api.decodeSid(stringPtr));
        return { start, owner };
      } finally {
        api.free(stringPtr);
      }
    } finally {
      api.close(token);
    }
  } finally {
    api.close(handle);
  }
}
