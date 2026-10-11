import type { RequestOptions, Scheduler } from "./types.ts";
import { ClientError } from "./types.ts";

interface Waiter {
  durable: boolean;
  resolve(value: unknown): void;
  reject(error: ClientError): void;
  cleanup(): void;
}
export class Requests {
  #waiters = new Map<string, Waiter>();
  #scheduler: Scheduler;
  #limit: number;
  #timeout: number;
  constructor(scheduler: Scheduler, limit: number, timeout: number) {
    this.#scheduler = scheduler;
    this.#limit = limit;
    this.#timeout = timeout;
  }
  wait<T>(
    id: string,
    decode: (value: unknown) => T,
    options: RequestOptions,
    send: () => void,
  ): Promise<T> {
    return this.#add(id, decode, options, send, false);
  }
  /** A durable command waits across reconnects and has no failure deadline. */
  waitDurable<T>(
    id: string,
    decode: (value: unknown) => T,
    options: RequestOptions,
    send: () => void,
  ): Promise<T> {
    return this.#add(id, decode, options, send, true);
  }
  #add<T>(
    id: string,
    decode: (value: unknown) => T,
    options: RequestOptions,
    send: () => void,
    durable: boolean,
  ): Promise<T> {
    const timeout = options.timeoutMs ?? this.#timeout;
    if (!Number.isSafeInteger(timeout) || timeout <= 0)
      return Promise.reject(new ClientError("limit"));
    if (options.signal?.aborted) return Promise.reject(new ClientError("aborted"));
    if (this.#waiters.size >= this.#limit || this.#waiters.has(id))
      return Promise.reject(new ClientError("limit"));
    return new Promise<T>((resolve, reject) => {
      const fail = (error: ClientError) => {
        this.#remove(id)?.reject(error);
      };
      const abort = () => fail(new ClientError("aborted"));
      const cancel = durable
        ? () => {}
        : this.#scheduler.set(timeout, () => fail(new ClientError("timeout")));
      this.#waiters.set(id, {
        durable,
        resolve: (value) => {
          try {
            resolve(decode(value));
          } catch {
            reject(new ClientError("protocol"));
          }
        },
        reject,
        cleanup: () => {
          cancel();
          options.signal?.removeEventListener("abort", abort);
        },
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        send();
      } catch (error) {
        fail(error instanceof ClientError ? error : new ClientError("offline"));
      }
    });
  }
  #remove(id: string): Waiter | undefined {
    const waiter = this.#waiters.get(id);
    this.#waiters.delete(id);
    waiter?.cleanup();
    return waiter;
  }
  resolve(id: string, value: unknown): void {
    this.#remove(id)?.resolve(value);
  }
  reject(id: string, error: ClientError): void {
    this.#remove(id)?.reject(error);
  }
  disconnect(): void {
    for (const [id, waiter] of this.#waiters)
      if (!waiter.durable) this.reject(id, new ClientError("offline"));
  }
  clear(error: ClientError): void {
    for (const id of this.#waiters.keys()) this.reject(id, error);
  }
}
