// Windows Volume GUID cwd probe.
// See https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
// See https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew
// See https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getlogicaldrives
// See https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-closehandle
// See https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import koffi from "koffi";
import { expect, test } from "vitest";
import { z } from "zod";
import { execute, scratch } from "./test-repo.ts";

function cleanEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
}

// kernel32 loader; caller runs only on Windows.
function kernel() {
  const lib = koffi.load("kernel32.dll");
  const CreateFileW = lib.func(
    "void* __stdcall CreateFileW(str16, uint32, uint32, void*, uint32, uint32, void*)",
  );
  const FinalPath = lib.func(
    "uint32 __stdcall GetFinalPathNameByHandleW(void*, void*, uint32, uint32)",
  );
  const Drives = lib.func("uint32 __stdcall GetLogicalDrives()");
  const Close = lib.func("int __stdcall CloseHandle(void*)");
  return { CreateFileW, FinalPath, Drives, Close, unload: () => lib.unload() };
}

// INVALID_HANDLE_VALUE check.
function isInvalid(handle: unknown): boolean {
  return (
    handle === null ||
    handle === 0 ||
    handle === 0n ||
    handle === -1 ||
    handle === -1n ||
    handle === 4294967295 ||
    handle === 18446744073709551615n
  );
}

// Open directory with BACKUP_SEMANTICS plus OPEN_REPARSE_POINT; query GUID name; hold no DELETE share.
function guidFor(target: string): string {
  const { CreateFileW, FinalPath, Close, unload } = kernel();
  const handle: unknown = CreateFileW(target, 128, 3, null, 3, 33554432 + 2097152, null);
  if (isInvalid(handle)) {
    unload();
    throw new Error("CreateFileW failed");
  }
  let guid = "";
  let closedOk = false;
  try {
    try {
      const buf = Buffer.alloc(32768);
      const length: unknown = FinalPath(handle, buf, 16384, 1);
      const count = z.number().int().positive().parse(length);
      if (count * 2 >= buf.length) throw new Error("GUID name truncated");
      guid = z
        .string()
        .min(1)
        .parse(buf.toString("utf16le", 0, count * 2));
    } finally {
      const closed: unknown = Close(handle);
      closedOk = z.number().int().parse(closed) !== 0;
    }
    if (!closedOk) throw new Error("CloseHandle failed");
    return guid;
  } finally {
    unload();
  }
}

// Pick vacant letter; skip current drive letter.
function pickVacant(mask: number, current: string): string {
  for (let code = 90; code >= 68; code--) {
    const letter = String.fromCharCode(code);
    if (letter === current) continue;
    const bit = 1 << (code - 65);
    if ((mask & bit) === 0) return letter + ":";
  }
  throw new Error("No vacant drive letter");
}

// Node forwards cwd to CreateProcessW lpCurrentDirectory.
function readViaCwd(cwd: string): Promise<string> {
  return execute(
    process.execPath,
    ["-e", "process.stdout.write(require('node:fs').readFileSync('sentinel.txt','utf8'))"],
    { cwd, timeout: PROCESS_TEST_TIMEOUT, env: cleanEnv() },
  ).then((result) => z.string().parse(result.stdout.toString()));
}

test("volume GUID cwd survives self-owned DOS remap for Node plus Git", async (context) => {
  if (process.platform !== "win32") context.skip("needs Windows");
  const base = await scratch();
  const original = join(base, "orig-雪");
  const decoy = join(base, "decoy-雪");
  await mkdir(original, { recursive: true });
  await mkdir(decoy, { recursive: true });
  await writeFile(join(original, "sentinel.txt"), "original-雪\n");
  await writeFile(join(decoy, "sentinel.txt"), "decoy-雪\n");
  // Core GUID probe: child reading relative sentinel must match original.
  const guid = guidFor(original);
  expect(guid.startsWith("\\\\?\\Volume{")).toBe(true);
  expect(await readViaCwd(guid)).toBe("original-雪\n");
  const drivesLib = kernel();
  let mask = 0;
  try {
    const maskUnknown: unknown = drivesLib.Drives();
    mask = z.number().int().nonnegative().parse(maskUnknown);
  } finally {
    drivesLib.unload();
  }
  const cwdDrive = process.cwd().slice(0, 1).toUpperCase();
  const drive = pickVacant(mask, cwdDrive);
  const systemRoot = z.string().min(1).parse(process.env.SystemRoot);
  const substExe = join(systemRoot, "System32", "subst.exe");
  const env = cleanEnv();
  // Self-owned redirection: create on vacant letter targeting own original.
  await execute(substExe, [drive, original], { timeout: PROCESS_TEST_TIMEOUT, env });
  let mapped = true;
  try {
    // GUID from redirection handle must equal original GUID.
    expect(guidFor(drive + "\\")).toBe(guid);
    await execute(substExe, [drive, "/D"], { timeout: PROCESS_TEST_TIMEOUT, env });
    mapped = false;
    await execute(substExe, [drive, decoy], { timeout: PROCESS_TEST_TIMEOUT, env });
    mapped = true;
    // Point redirection to decoy; GUID cwd still reads original; DOS cwd reads decoy.
    expect(await readViaCwd(guid)).toBe("original-雪\n");
    expect(await readViaCwd(drive + "\\")).toBe("decoy-雪\n");
    // Git smoke: init in own original; GUID cwd runs rev-parse plus status.
    await execute("git", ["init"], { cwd: original, timeout: PROCESS_TEST_TIMEOUT, env });
    const top = await execute("git", ["rev-parse", "--show-toplevel"], {
      cwd: guid,
      timeout: PROCESS_TEST_TIMEOUT,
      env,
    });
    expect(z.string().parse(top.stdout.toString()).trim().length).toBeGreaterThan(0);
    const status = await execute("git", ["status", "--porcelain"], {
      cwd: guid,
      timeout: PROCESS_TEST_TIMEOUT,
      env,
    });
    expect(status.stdout.toString().trim()).toBe("?? sentinel.txt");
  } finally {
    if (mapped) await execute(substExe, [drive, "/D"], { timeout: PROCESS_TEST_TIMEOUT, env });
  }
});

test("directory lease without FILE_SHARE_DELETE blocks Windows rename", async (context) => {
  if (process.platform !== "win32") context.skip("needs Windows");
  const parent = await scratch();
  const child = join(parent, "child-雪");
  await mkdir(child, { recursive: true });
  // Attributes-only handles do not establish this share denial. Request actual
  // directory read access and hold the child without DELETE share.
  const leaseLib = kernel();
  const handle: unknown = leaseLib.CreateFileW(
    child,
    0x80000000,
    3,
    null,
    3,
    33554432 + 2097152,
    null,
  );
  if (isInvalid(handle)) {
    leaseLib.unload();
    throw new Error("CreateFileW failed");
  }
  const moved = join(parent, "moved-雪");
  let closedOk = false;
  try {
    try {
      await expect(rename(child, moved)).rejects.toThrow();
    } finally {
      const closed: unknown = leaseLib.Close(handle);
      closedOk = z.number().int().parse(closed) !== 0;
    }
    if (!closedOk) throw new Error("CloseHandle failed");
  } finally {
    leaseLib.unload();
  }
  // Following close, rename wins.
  await rename(child, moved);
  await writeFile(join(moved, "ok.txt"), "ok\n");
  expect(await readFile(join(moved, "ok.txt"), "utf8")).toBe("ok\n");
});
