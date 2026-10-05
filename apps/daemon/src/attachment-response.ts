import type { ServerResponse } from "node:http";
import { systemDeliveryRuntime, type DeliveryRuntime } from "./delivery-runtime.ts";

/** Response lifetime covers storage waits and socket backpressure, not just request ingress. */
export function attachmentResponse(
  response: ServerResponse,
  runtime: Pick<DeliveryRuntime, "delay"> = systemDeliveryRuntime,
) {
  let closed = false;
  const pending = new Set<() => void>();
  const onClose = () => {
    closed = true;
    for (const abort of pending) abort();
    pending.clear();
  };
  response.once("close", onClose);
  const cancel = runtime.delay(() => response.destroy(), 30_000);
  // Detach each completed wait. Repeated Promise.race against one unresolved
  // close promise would retain all prior chunks until the response closed.
  const wait = <T>(operation: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Attachment response closed"));
      if (closed || response.destroyed) abort();
      else pending.add(abort);
      void operation.then(
        (value) => {
          pending.delete(abort);
          resolve(value);
        },
        (error: unknown) => {
          pending.delete(abort);
          reject(error);
        },
      );
    });
  return {
    wait,
    async drain(): Promise<void> {
      const { promise: writable, resolve: done } = Promise.withResolvers<void>();
      response.once("drain", done);
      try {
        await wait(writable);
      } finally {
        response.off("drain", done);
      }
    },
    async end(): Promise<void> {
      const { promise: finished, resolve: done } = Promise.withResolvers<void>();
      response.once("finish", done);
      response.end();
      try {
        await wait(finished);
      } finally {
        response.off("finish", done);
      }
    },
    close(): void {
      cancel();
      response.off("close", onClose);
    },
  };
}
