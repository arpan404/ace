import type { SpawnPosixExecutor } from "./posix-executor.ts";
import { PosixLanes, type PosixLimits } from "./posix-lanes.ts";
import { PosixThread } from "./posix-thread.ts";
import type { PosixOperation, PosixReply } from "./posix-wire.ts";

/**
 * Tests only: lanes whose "threads" run the real native calls on this thread, one call per
 * turn, with the same handle table as a worker. A call that `stall` picks never returns until
 * `release` is called, the way a call into a dead mount blocks; a draining thread waits for it,
 * then closes what it owns and exits.
 */
export function inlineLanes(
  stall: (operation: PosixOperation) => boolean,
  limits: Partial<PosixLimits> = {},
): { lanes: PosixLanes; release(): void } {
  const stuck: (() => void)[] = [];
  const spawn: SpawnPosixExecutor = (events) => {
    const thread = new PosixThread();
    let blocked = false;
    let draining = false;
    const answer = (id: number, operation: PosixOperation) => {
      let reply: PosixReply;
      try {
        reply = { id, ok: true, value: thread.run(operation) };
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        const message = error instanceof Error ? error.message : "Native call failed";
        reply = { id, ok: false, message, ...(typeof code === "string" ? { code } : {}) };
      }
      events.reply(reply);
    };
    const exit = () => {
      thread.release();
      events.exit();
    };
    return {
      send(id, operation) {
        if (!stall(operation)) return void setImmediate(() => answer(id, operation));
        blocked = true;
        stuck.push(() => {
          blocked = false;
          answer(id, operation);
          if (draining) exit();
        });
      },
      hold: () => {},
      drain() {
        draining = true;
        if (!blocked) setImmediate(exit);
      },
    };
  };
  const lanes = new PosixLanes({
    spawn,
    timer(run, ms) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    deadlineMs: 10_000,
    idleMs: 30_000,
    spares: 2,
    stuckPerRoot: 2,
    maxWorkers: 8,
    maxThreads: 16,
    ...limits,
  });
  return {
    lanes,
    release() {
      for (const run of stuck.splice(0)) run();
    },
  };
}
