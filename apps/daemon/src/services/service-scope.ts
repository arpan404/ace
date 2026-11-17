import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which service's code is running: its start, its listeners, and whatever they leave running
 * (timers, callbacks, promise continuations inherit the context). A fatal error raised there is
 * charged to that service, so safe mode can leave it off (ADR 0175).
 *
 * Bun and Node both carry the context into an uncaught exception's monitor. Only Node carries
 * it into an `unhandledRejection` listener; on Bun such a crash goes unattributed.
 */
export class ServiceScope {
  private readonly storage = new AsyncLocalStorage<string>();
  run<T>(service: string, work: () => T): T {
    return this.storage.run(service, work);
  }
  current(): string | undefined {
    return this.storage.getStore();
  }
}
