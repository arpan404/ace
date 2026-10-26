import { createRequire } from "node:module";
import type koffiModule from "koffi";
import { z } from "zod";

/**
 * Kernel containment for one supervised tree where process groups do not exist: a Windows Job
 * Object. (POSIX trees are owned through their process group in `process-owner.ts`.) The OS kills
 * every member when the daemon's last job handle closes, including after a hard kill or crash
 * where no userspace hook can run. Assignment is best-effort: a process that cannot join stays
 * under the taskkill tree stop. kernel32 loads only when a job is created, never on import.
 */
export type ProcessJob = {
  /** A failing join never throws; the tree stop remains the owner. */
  assign(pid: number): void;
  dispose(): void;
};
export type ProcessJobFactory = () => ProcessJob | undefined;

/** Raw Win32 surface behind the job. Tests inject a fake; production uses koffi. */
export type JobObjectApi = {
  create: () => unknown;
  setKillOnClose: (job: unknown) => boolean;
  openProcess: (pid: number) => unknown;
  assignProcess: (job: unknown, target: unknown) => boolean;
  close: (handle: unknown) => void;
  unload: () => void;
  activeCount: (job: unknown) => number;
  terminate: (job: unknown) => void;
};

const killOnJobClose = 0x2000;
const extendedLimitInformation = 9;
const processSetQuota = 0x0100;
const processTerminate = 0x0001;
const integer = z.number().int();

/**
 * KILL_ON_JOB_CLOSE requires JOBOBJECT_EXTENDED_LIMIT_INFORMATION, class 9.
 * Its basic-limit prefix includes alignment before SIZE_T and ULONG_PTR.
 * The complete SDK layout is 144 bytes on x64/ARM64, 112 bytes on x86/32-bit ARM.
 * https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information
 */
function killOnCloseInfo(): Buffer {
  const info = Buffer.alloc(process.arch === "ia32" || process.arch === "arm" ? 112 : 144);
  info.writeUInt32LE(killOnJobClose, 16);
  return info;
}

/**
 * Thin koffi shell over kernel32; every native result is validated before use. koffi is
 * required here, not imported, so bundles without native packages (the desktop main
 * process reaches this through `process.ts`) still build; there a failing load leaves the
 * taskkill tree stop in charge.
 */
export function loadJobObjectApi(): JobObjectApi {
  const koffi: typeof koffiModule = createRequire(import.meta.url)("koffi");
  const library = koffi.load("kernel32.dll");
  try {
    const createJobObject = library.func(
      "void* __stdcall CreateJobObjectW(void* attrs, void* name)",
    );
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
    const query = library.func(
      "int __stdcall QueryInformationJobObject(void* job, int infoClass, _Out_ void* info, uint length, void* returned)",
    );
    const terminate = library.func("int __stdcall TerminateJobObject(void* job, uint exitCode)");
    return {
      create: () => createJobObject(null, null),
      setKillOnClose: (job) => {
        const info = killOnCloseInfo();
        return (
          integer.parse(
            setInformationJobObject(job, extendedLimitInformation, info, info.length),
          ) !== 0
        );
      },
      openProcess: (pid) => openProcess(processSetQuota | processTerminate, 0, pid),
      assignProcess: (job, target) => integer.parse(assignProcessToJobObject(job, target)) !== 0,
      close: (handle) => {
        if (integer.parse(closeHandle(handle)) === 0)
          throw new Error("Windows handle close failed");
      },
      activeCount(job) {
        // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: four LARGE_INTEGERs and four DWORDs.
        const info = Buffer.alloc(48);
        if (integer.parse(query(job, 1, info, info.length, null)) === 0)
          throw new Error("Windows job inspection failed");
        return info.readUInt32LE(40);
      },
      terminate(job) {
        if (integer.parse(terminate(job, 1)) === 0)
          throw new Error("Windows job termination failed");
      },
      unload: () => {
        library.unload();
      },
    };
  } catch (error) {
    try {
      library.unload();
    } catch {
      /* Keep the binding error. */
    }
    throw error;
  }
}

/** Retains the kernel job independently of its original shell's lifetime. */
export interface RetainedJob {
  assign(pid: number): void;
  activeCount(): number;
  terminate(): void;
  dispose(): void;
}

function nullHandle(value: unknown): boolean {
  return value === null || value === undefined || value === 0 || value === 0n;
}

/** Required containment. Setup, assignment and inspection failures stay visible. */
export function createRetainedJob(load: () => JobObjectApi = loadJobObjectApi): RetainedJob {
  const api = load();
  let handle: unknown;
  try {
    handle = api.create();
    if (nullHandle(handle)) throw new Error("Windows job creation failed");
    if (!api.setKillOnClose(handle)) throw new Error("Windows job setup failed");
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      if (!nullHandle(handle)) api.close(handle);
    } catch (cleanup) {
      failures.push(cleanup);
    }
    try {
      api.unload();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (failures.length > 1)
      throw new AggregateError(failures, "Windows job setup and cleanup failed", { cause: error });
    throw error;
  }
  let handleClosed = false;
  let unloaded = false;
  const pendingHandles = new Set<unknown>();
  function requireOpen(): void {
    if (handleClosed) throw new Error("Windows job is closed");
  }
  return {
    assign(pid) {
      requireOpen();
      z.number().int().min(1).max(0xffffffff).parse(pid);
      const target = api.openProcess(pid);
      if (nullHandle(target)) throw new Error("Windows process cannot join its job");
      pendingHandles.add(target);
      const failures: unknown[] = [];
      try {
        if (!api.assignProcess(handle, target)) throw new Error("Windows job assignment failed");
      } catch (error) {
        failures.push(error);
      }
      try {
        api.close(target);
        pendingHandles.delete(target);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Windows job assignment and cleanup failed", {
          cause: failures[0],
        });
    },
    activeCount() {
      requireOpen();
      return z.number().int().nonnegative().parse(api.activeCount(handle));
    },
    terminate() {
      requireOpen();
      api.terminate(handle);
    },
    dispose() {
      for (const pending of pendingHandles) {
        api.close(pending);
        pendingHandles.delete(pending);
      }
      // Handle close and library unload can each retry without double-closing.
      if (!handleClosed) {
        api.close(handle);
        handleClosed = true;
      }
      if (!unloaded) {
        api.unload();
        unloaded = true;
      }
    },
  };
}

/** Optional containment for existing supervised processes using tree-stop fallback. */
export function createKillOnCloseJob(
  load: () => JobObjectApi = loadJobObjectApi,
): ProcessJob | undefined {
  try {
    const job = createRetainedJob(load);
    return {
      assign(pid) {
        try {
          job.assign(pid);
        } catch {
          /* Existing tree stop remains responsible. */
        }
      },
      dispose() {
        try {
          job.dispose();
        } catch {
          /* Best effort during process exit. */
        }
      },
    };
  } catch {
    return undefined;
  }
}
