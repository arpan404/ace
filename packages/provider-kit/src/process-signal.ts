import { constants } from "node:os";
import { openLibrary, type NativeFunction } from "./bun-ffi.ts";

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

export interface PidFds {
  /** A pidfd for whatever process holds `pid` now; undefined when none does. */
  open(pid: number): number | undefined;
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

/** Signal `member` if it is still that process: "sent", or "gone" when it isn't any more. */
export function signalMember(
  member: { pid: number; start: string },
  signal: NodeJS.Signals,
  io: SignalIo,
): "sent" | "gone" {
  const fd = io.pidfd?.open(member.pid);
  if (fd !== undefined) {
    try {
      // The pidfd pins one process; its start says whether it is the one we know.
      if (io.start(member.pid) !== member.start) return "gone";
      return io.pidfd?.send(fd, signal) ? "sent" : "gone";
    } finally {
      io.pidfd?.close(fd);
    }
  }
  if (io.start(member.pid) !== member.start) return "gone";
  try {
    io.kill(member.pid, signal);
    return "sent";
  } catch {
    return "gone";
  }
}

type Libc = Readonly<Record<"pidfd_open" | "pidfd_send_signal" | "close", NativeFunction>>;
let libc: Libc | null | undefined;
/** glibc 2.36's pidfd wrappers (every supported distribution has them); null where absent. */
function linuxPidfdLibc(): Libc | null {
  if (libc !== undefined) return libc;
  try {
    libc = openLibrary("libc.so.6", {
      pidfd_open: { args: ["i32", "u32"], returns: "i32" },
      pidfd_send_signal: { args: ["i32", "i32", "ptr", "u32"], returns: "i32" },
      close: { args: ["i32"], returns: "i32" },
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
      const fd = Number(native.pidfd_open(pid, 0));
      return Number.isSafeInteger(fd) && fd >= 0 ? fd : undefined;
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
