import type { Scheduler } from "@ace/client";

/** Probe from the page's active timers; hidden/frozen pages are never timed out for silence. */
export class WorkerLiveness {
  #scheduler: Scheduler;
  #lost: () => void;
  #send: () => void;
  #interval: number;
  #deadline: number;
  #visible = true;
  #stopped = false;
  #ping: (() => void) | undefined;
  #reply: (() => void) | undefined;
  #attach: (() => void) | undefined;
  constructor(
    scheduler: Scheduler,
    send: () => void,
    lost: () => void,
    interval: number,
    deadline: number,
  ) {
    if (
      !Number.isSafeInteger(interval) ||
      interval <= 0 ||
      !Number.isSafeInteger(deadline) ||
      deadline <= 0
    )
      throw new RangeError("Worker liveness deadlines must be positive integers");
    this.#scheduler = scheduler;
    this.#send = send;
    this.#lost = lost;
    this.#interval = interval;
    this.#deadline = deadline;
  }
  start(): void {
    this.#attach = this.#scheduler.set(this.#deadline, this.#lost);
    this.#schedule();
  }
  attached(): void {
    this.#attach?.();
    this.#attach = undefined;
  }
  received(): void {
    this.#reply?.();
    this.#reply = undefined;
  }
  visible(value: boolean): void {
    this.#visible = value;
    this.received();
    if (value && !this.#stopped) this.#probe();
  }
  #probe(): void {
    if (this.#visible && !this.#reply)
      this.#reply = this.#scheduler.set(this.#deadline, this.#lost);
    this.#send();
  }
  #schedule(): void {
    this.#ping = this.#scheduler.set(this.#interval, () => {
      if (this.#stopped) return;
      this.#probe();
      this.#schedule();
    });
  }
  close(): void {
    this.#stopped = true;
    this.#attach?.();
    this.#ping?.();
    this.received();
  }
}

export function replyTimeout(args: unknown[], fallback: number): number {
  for (const value of args) {
    if (typeof value === "object" && value !== null && "timeoutMs" in value) {
      if (typeof value.timeoutMs === "number") return value.timeoutMs;
    }
  }
  return fallback;
}
