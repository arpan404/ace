import type { Command, DeviceId } from "@ace/protocol";

/**
 * The order key of a command: commands that touch the same thread (or workspace) run one at a
 * time in arrival order, whichever socket of the device carried them. Unrelated work does not
 * wait. A replay after a reconnect lands behind the attempt it repeats, so it finds that
 * attempt's receipt instead of racing it.
 */
export function commandLane(command: Command, device: DeviceId): string {
  const payload: Record<string, unknown> = command.payload;
  const link = payload.link;
  const thread =
    typeof payload.threadId === "string"
      ? payload.threadId
      : typeof link === "object" && link !== null && "threadId" in link
        ? String(link.threadId)
        : undefined;
  if (thread) return `${device}\0thread\0${thread}`;
  if (typeof payload.workspaceId === "string")
    return `${device}\0workspace\0${payload.workspaceId}`;
  return `${device}\0device`;
}

/**
 * Per-key FIFO chains for accepted commands, kept off the socket input queue so a slow command
 * (provider activation, git hooks, a long push) never holds liveness traffic behind it.
 */
export class CommandLanes {
  #tails = new Map<string, Promise<void>>();
  #pending = new Map<string, number>();
  #tasks = new Set<Promise<void>>();
  /** Queue `task` behind earlier work on `lane`; resolves when it has run. Never rejects. */
  run(lane: string, device: DeviceId, commandId: string, task: () => Promise<void>): Promise<void> {
    const key = `${device}\0${commandId}`;
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);
    const previous = this.#tails.get(lane) ?? Promise.resolve();
    const done = previous.then(task).then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(lane, done);
    this.#tasks.add(done);
    void done.finally(() => {
      this.#tasks.delete(done);
      const count = (this.#pending.get(key) ?? 1) - 1;
      if (count > 0) this.#pending.set(key, count);
      else this.#pending.delete(key);
      if (this.#tails.get(lane) === done) this.#tails.delete(lane);
    });
    return done;
  }
  /** True while a command is queued or executing on any lane. */
  running(device: DeviceId, commandId: string): boolean {
    return this.#pending.has(`${device}\0${commandId}`);
  }
  size(): number {
    return this.#tasks.size;
  }
  settled(): Promise<void> {
    return Promise.allSettled(this.#tasks).then(() => undefined);
  }
}

/** Resolve once `task` settles or `milliseconds` pass, whichever is first. */
export function settledWithin(
  task: Promise<void>,
  milliseconds: number,
  delay: (run: () => void, milliseconds: number) => () => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const cancel = delay(resolve, milliseconds);
    void task.finally(() => {
      cancel();
      resolve();
    });
  });
}
