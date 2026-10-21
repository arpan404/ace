import { createRequire } from "node:module";
import type koffiModule from "koffi";
import { z } from "zod";

/**
 * Kernel containment for one supervised tree. The OS kills every member when
 * the daemon's last job handle closes, including after a hard kill or crash
 * where no userspace hook can run. Assignment is best-effort: a process that
 * cannot join stays under the taskkill tree stop.
 */
export type WindowsJob = {
  /** A failing join never throws; the tree stop remains the owner. */
  assign(pid: number): void;
  dispose(): void;
};
export type WindowsJobFactory = () => WindowsJob | undefined;

/** Raw Win32 surface behind the job. Tests inject a fake; production uses koffi. */
export type WindowsJobApi = {
  create: () => unknown;
  setKillOnClose: (job: unknown) => boolean;
  openProcess: (pid: number) => unknown;
  assignProcess: (job: unknown, target: unknown) => boolean;
  close: (handle: unknown) => void;
  unload: () => void;
};

const killOnJobClose = 0x2000;
const basicLimitInformation = 2;
const processSetQuota = 0x0100;
const processTerminate = 0x0001;
const integer = z.number().int();

/**
 * JOBOBJECT_BASIC_LIMIT_INFORMATION with only KILL_ON_JOB_CLOSE set. The flag
 * sits at offset 16 on every architecture; the tail size follows the pointer
 * width so the same bytes work on x64, ARM64 and x86 Windows.
 */
export function killOnCloseInfo(): Buffer {
  const pointer = process.arch === "ia32" ? 4 : 8;
  const info = Buffer.alloc(32 + 3 * pointer);
  info.writeUInt32LE(killOnJobClose, 16);
  return info;
}

/**
 * Thin koffi shell over kernel32; every native result is validated before use. koffi is
 * required here, not imported, so bundles without native packages (the desktop main
 * process reaches this through `process.ts`) still build; there a failing load leaves the
 * taskkill tree stop in charge.
 */
export function loadWindowsJobApi(): WindowsJobApi {
  const koffi: typeof koffiModule = createRequire(import.meta.url)("koffi");
  const library = koffi.load("kernel32.dll");
  const createJobObject = library.func("void* __stdcall CreateJobObjectW(void* attrs, void* name)");
  const setInformationJobObject = library.func(
    "int __stdcall SetInformationJobObject(void* job, int infoClass, void* info, uint length)",
  );
  const openProcess = library.func(
    "void* __stdcall OpenProcess(uint access, int inherit, uint pid)",
  );
  const assignProcessToJobObject = library.func(
    "int __stdcall AssignProcessToJobObject(void* job, void* target)",
  );
  const closeHandle = library.func("int __stdcall CloseHandle(void* handle)");
  return {
    create: () => createJobObject(null, null),
    setKillOnClose: (job) => {
      const info = killOnCloseInfo();
      return (
        integer.parse(setInformationJobObject(job, basicLimitInformation, info, info.length)) !== 0
      );
    },
    openProcess: (pid) => openProcess(processSetQuota | processTerminate, 0, pid),
    assignProcess: (job, target) => integer.parse(assignProcessToJobObject(job, target)) !== 0,
    close: (handle) => {
      closeHandle(handle);
    },
    unload: () => {
      library.unload();
    },
  };
}

/**
 * One kill-on-close job. Returns undefined when the platform has no Job
 * Objects (or setup fails) so callers fall back to the taskkill tree stop.
 */
export function createKillOnCloseJob(
  load: () => WindowsJobApi = loadWindowsJobApi,
): WindowsJob | undefined {
  let api: WindowsJobApi | undefined;
  try {
    const loaded = load();
    api = loaded;
    const job = loaded.create();
    // A NULL handle fails here, so no representation check is needed.
    if (!loaded.setKillOnClose(job)) throw new Error("Windows job setup failed");
    let disposed = false;
    const owner = loaded;
    const handle = job;
    return {
      assign(pid) {
        if (disposed) return;
        try {
          const target = owner.openProcess(pid);
          try {
            owner.assignProcess(handle, target);
          } finally {
            owner.close(target);
          }
        } catch {
          // Joining the job is hardening; the tree stop still owns the process.
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          owner.close(handle);
        } catch {
          // Disposal runs on process exit; a failing close cannot block it.
        } finally {
          try {
            owner.unload();
          } catch {
            // The library handle is already accounted for by the failed close.
          }
          api = undefined;
        }
      },
    };
  } catch {
    // No Job Objects here; the taskkill tree stop remains the owner.
    try {
      api?.unload();
    } catch {
      // Loading succeeded but setup failed; nothing is held.
    }
    return undefined;
  }
}
