import { createRequire } from "node:module";
import type koffiModule from "koffi";
import { z } from "zod";

/**
 * Windows Job Object containment for a tree where process groups do not exist. The kernel kills
 * every member when the daemon's last handle closes, even after a crash. kernel32 loads only
 * when a job is created, never on import.
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
  activeCount: (job: unknown) => number;
  terminate: (job: unknown) => void;
};

const integer = z.number().int();
function check(result: unknown, failure: string): void {
  if (integer.parse(result) === 0) throw new Error(failure);
}

// koffi is required lazily so bundles without native packages (the desktop main process
// reaches this through process.ts) still build; a failed load leaves the tree stop in charge.
function loadWindowsJobApi(): WindowsJobApi {
  const koffi: typeof koffiModule = createRequire(import.meta.url)("koffi");
  const library = koffi.load("kernel32.dll");
  try {
    const create = library.func("void* __stdcall CreateJobObjectW(void* attrs, void* name)");
    const setInfo = library.func(
      "int __stdcall SetInformationJobObject(void* job, int infoClass, void* info, uint length)",
    );
    const openProcess = library.func(
      "void* __stdcall OpenProcess(uint access, int inherit, uint pid)",
    );
    const assign = library.func("int __stdcall AssignProcessToJobObject(void* job, void* target)");
    const closeHandle = library.func("int __stdcall CloseHandle(void* handle)");
    const query = library.func(
      "int __stdcall QueryInformationJobObject(void* job, int infoClass, _Out_ void* info, uint length, void* returned)",
    );
    const terminate = library.func("int __stdcall TerminateJobObject(void* job, uint exitCode)");
    return {
      create: () => create(null, null),
      setKillOnClose: (job) => {
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (class 9) is 144 bytes on 64-bit, 112 on 32-bit;
        // LimitFlags sits at offset 16 and 0x2000 is KILL_ON_JOB_CLOSE.
        const info = Buffer.alloc(process.arch === "ia32" || process.arch === "arm" ? 112 : 144);
        info.writeUInt32LE(0x2000, 16);
        return integer.parse(setInfo(job, 9, info, info.length)) !== 0;
      },
      // PROCESS_SET_QUOTA | PROCESS_TERMINATE are the rights AssignProcessToJobObject needs.
      openProcess: (pid) => openProcess(0x0100 | 0x0001, 0, pid),
      assignProcess: (job, target) => integer.parse(assign(job, target)) !== 0,
      close: (handle) => check(closeHandle(handle), "Windows handle close failed"),
      activeCount(job) {
        // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (class 1): ActiveProcesses at offset 40.
        const info = Buffer.alloc(48);
        check(query(job, 1, info, info.length, null), "Windows job inspection failed");
        return info.readUInt32LE(40);
      },
      terminate: (job) => check(terminate(job, 1), "Windows job termination failed"),
      unload: () => library.unload(),
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
export function createRetainedJob(load: () => WindowsJobApi = loadWindowsJobApi): RetainedJob {
  const api = load();
  let handle: unknown;
  try {
    handle = api.create();
    if (nullHandle(handle)) throw new Error("Windows job creation failed");
    if (!api.setKillOnClose(handle)) throw new Error("Windows job setup failed");
  } catch (error) {
    try {
      if (!nullHandle(handle)) api.close(handle);
    } finally {
      api.unload();
    }
    throw error;
  }
  let handleClosed = false;
  let unloaded = false;
  const open = () => {
    if (handleClosed) throw new Error("Windows job is closed");
    return handle;
  };
  return {
    assign(pid) {
      const job = open();
      const target = api.openProcess(z.number().int().min(1).max(0xffffffff).parse(pid));
      if (nullHandle(target)) throw new Error("Windows process cannot join its job");
      try {
        if (!api.assignProcess(job, target)) throw new Error("Windows job assignment failed");
      } finally {
        api.close(target);
      }
    },
    activeCount: () => z.number().int().nonnegative().parse(api.activeCount(open())),
    terminate: () => api.terminate(open()),
    dispose() {
      // A failed close or unload can retry without double-closing.
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

/** Optional containment: any failure leaves the taskkill tree stop in charge. */
export function createKillOnCloseJob(
  load: () => WindowsJobApi = loadWindowsJobApi,
): WindowsJob | undefined {
  let job: RetainedJob;
  try {
    job = createRetainedJob(load);
  } catch {
    return undefined;
  }
  return {
    assign(pid) {
      try {
        job.assign(pid);
      } catch {
        /* The tree stop remains responsible. */
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
}
