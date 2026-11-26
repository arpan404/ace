// SPDX-License-Identifier: Apache-2.0
/**
 * The facade's pending calls (E5.1): one deferred per binding call or frame batch, and the
 * threadsafe-function holders that keep the addon alive while one is outstanding.
 */
import { closed, type NativeEngineHandle, type Settled } from "./contracts.ts";

export class Calls {
  private readonly pending = new Map<number, Settled>();
  private readonly binding: NativeEngineHandle;
  private next = 1;
  private holders = 0;

  constructor(binding: NativeEngineHandle) {
    this.binding = binding;
  }

  hold(): void {
    this.holders += 1;
    this.binding.hold?.();
  }

  releaseHolder(): void {
    if (this.holders === 0) return;
    this.holders -= 1;
    this.binding.releaseHold?.();
  }

  call<T = void>(invoke: (call: number) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const call = this.next++;
      this.pending.set(call, { resolve: resolve as (value: undefined) => void, reject });
      this.hold();
      try {
        invoke(call);
      } catch (error) {
        this.pending.delete(call);
        this.releaseHolder();
        reject(error as Error);
      }
    });
  }

  settle(call: number, error: string | null): void {
    const pending = this.pending.get(call);
    if (pending === undefined) return;
    this.pending.delete(call);
    this.releaseHolder();
    if (error === null) pending.resolve(undefined);
    else pending.reject(error === "Engine closed" ? closed() : new Error(error));
  }

  rejectAll(): void {
    for (const pending of this.pending.values()) pending.reject(closed());
    this.pending.clear();
    while (this.holders > 0) this.releaseHolder();
  }
}
