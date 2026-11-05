import { z } from "zod";
import { openLibrary, type NativeFunction } from "./bun-ffi.ts";

/**
 * Proves a Darwin child has exited without reaping it. Its PID stays reserved and the runtime
 * still receives the real wait status. kill(pid, 0) cannot distinguish this zombie from a live
 * child. A non-child, unreadable status or other platform supplies no such proof.
 */
// Bound once for the process: callers ask about every child they stop.
let waitid: NativeFunction | undefined;

export function childHasExited(pid: number): boolean {
  z.number().int().positive().parse(pid);
  if (process.platform !== "darwin") return false;
  waitid ??= openLibrary("/usr/lib/libSystem.B.dylib", {
    waitid: { args: ["i32", "u32", "ptr", "i32"], returns: "i32" },
  }).symbols.waitid;
  // Darwin's siginfo_t is 104 bytes on 64-bit hosts; si_pid follows three ints.
  const info = Buffer.alloc(104);
  // P_PID, WEXITED | WNOHANG | WNOWAIT, from Darwin's sys/wait.h.
  const result = waitid(1, pid, info, 0x04 | 0x01 | 0x20);
  return result === 0 && info.readInt32LE(12) === pid;
}
