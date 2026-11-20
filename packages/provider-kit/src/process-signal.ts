import { constants } from "node:os";
import { nativePointer, openLibrary, readInt32, type NativeFunction } from "./bun-ffi.ts";

/** ESRCH, ENOSYS in <errno.h> (Linux). */
const noSuchProcess = 3;
const notImplemented = 38;

/** What a failed pidfd_open's errno means for signalling. */
export function pidfdFailure(errno: number): { error: "gone" | "unsupported" | "unsafe" } {
  if (errno === noSuchProcess) return { error: "gone" };
  if (errno === notImplemented) return { error: "unsupported" };
  return { error: "unsafe" };
}

/*
 * Signalling a process by evidence (its pid and kernel start time) without hitting another
 * process that took the pid since.
 *
 * Linux: a pidfd. `pidfd_open` pins the process that holds the pid at that moment; its start
 * time is then checked against the evidence, and `pidfd_send_signal` reaches that process or,
 * once it has exited, nothing. A reused pid can never receive the signal.
 *
 * macOS (and Linux without pidfd): the pid's start time is re-read immediately before each
 * signal. What remains is the moment between that read and kill(2): the process would have to
 * exit, be reaped, and its pid be handed to a new process inside it. macOS hands out pids in
 * order up to 99,999 before reusing one, so that takes the whole pid range cycling within
 * microseconds.
 */

/**
 * What opening a pidfd gave: the descriptor, or why not. `gone`: no process holds the pid.
 * `unsupported`: this kernel has no pidfds (ENOSYS), the one case where kill(2) may stand in.
 * `unsafe`: anything else (EMFILE, ENFILE, ENOMEM): the process may be there, but it can't be
 * pinned, so it is not signalled at all.
 */
export type PidFdOpen = { fd: number } | { error: "gone" | "unsupported" | "unsafe" };

export interface PidFds {
  /** A pidfd for whatever process holds `pid` now. */
  open(pid: number): PidFdOpen;
  /** Signal the process the pidfd pins; false once it has exited. */
  send(fd: number, signal: NodeJS.Signals): boolean;
  close(fd: number): void;
}

export interface SignalIo {
  /** The start time of whatever process holds `pid` now, or undefined (gone, a zombie). */
  start(pid: number): string | undefined;
  /** kill(2) by pid. */
  kill(pid: number, signal: NodeJS.Signals): void;
  pidfd?: PidFds | undefined;
}

/**
 * Signal `member` if it is still that process: "sent"; "gone" when it isn't any more; "unsafe"
 * when it may be but couldn't be pinned to be signalled safely, so nothing was sent.
 */
export function signalMember(
  member: { pid: number; start: string },
  signal: NodeJS.Signals,
  io: SignalIo,
): "sent" | "gone" | "unsafe" {
  if (io.start(member.pid) !== member.start) return "gone";
  if (io.pidfd) {
    const opened = io.pidfd.open(member.pid);
    if ("fd" in opened) {
      try {
        // The pidfd pins one process; its start says whether it is the one we know.
        if (io.start(member.pid) !== member.start) return "gone";
        return io.pidfd.send(opened.fd, signal) ? "sent" : "gone";
      } finally {
        io.pidfd.close(opened.fd);
      }
    }
    if (opened.error !== "unsupported") return opened.error;
  }
  if (io.start(member.pid) !== member.start) return "gone";
  try {
    io.kill(member.pid, signal);
    return "sent";
  } catch {
    return "gone";
  }
}

type Libc = Readonly<
  Record<"pidfd_open" | "pidfd_send_signal" | "close" | "__errno_location", NativeFunction>
>;
let libc: Libc | null | undefined;
/** glibc 2.36's pidfd wrappers (every supported distribution has them); null where absent. */
function linuxPidfdLibc(): Libc | null {
  if (libc !== undefined) return libc;
  try {
    libc = openLibrary("libc.so.6", {
      pidfd_open: { args: ["i32", "u32"], returns: "i32" },
      pidfd_send_signal: { args: ["i32", "i32", "ptr", "u32"], returns: "i32" },
      close: { args: ["i32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    }).symbols;
  } catch {
    libc = null;
  }
  return libc;
}

/** Linux pidfds through bun:ffi, or undefined where the platform, libc or kernel lacks them. */
export function systemPidFds(platform: NodeJS.Platform = process.platform): PidFds | undefined {
  if (platform !== "linux") return undefined;
  const native = linuxPidfdLibc();
  if (!native) return undefined;
  return {
    open(pid) {
      const { pidfd_open, __errno_location } = native;
      const fd = Number(pidfd_open(pid, 0));
      if (Number.isSafeInteger(fd) && fd >= 0) return { fd };
      // Read before any other call can change it.
      const pointer = nativePointer(__errno_location());
      return pidfdFailure(pointer === null ? -1 : readInt32(pointer));
    },
    send(fd, signal) {
      return Number(native.pidfd_send_signal(fd, constants.signals[signal], null, 0)) === 0;
    },
    close(fd) {
      native.close(fd);
    },
  };
}

let setpgid: NativeFunction | null | undefined;
/**
 * Move this process into a process group of its own (setpgid(0, 0)). A command a provider's
 * shell runs is in that provider's group, which a daemon stop signals as one; once out of it,
 * the command lives to report. False where it can't (Windows, a session leader, no libc).
 */
export function leaveProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux" && platform !== "darwin") return false;
  try {
    setpgid ??= openLibrary(platform === "linux" ? "libc.so.6" : "/usr/lib/libSystem.B.dylib", {
      setpgid: { args: ["i32", "i32"], returns: "i32" },
    }).symbols.setpgid;
  } catch {
    setpgid = null;
  }
  return setpgid ? Number(setpgid(0, 0)) === 0 : false;
}
