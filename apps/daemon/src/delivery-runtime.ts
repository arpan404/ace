import { systemCredentials } from "./credential-runtime.ts";

export interface DeliveryRuntime {
  now(): number;
  id(): string;
  delay(callback: () => void, milliseconds: number): () => void;
  every(callback: () => void, milliseconds: number): () => void;
}

/** System effects stay at the socket/timer boundary; delivery logic accepts replacements. */
export const systemDeliveryRuntime: DeliveryRuntime = {
  now: () => Date.now(),
  id: () => systemCredentials.id(),
  delay(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
  every(callback, milliseconds) {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    return () => clearInterval(timer);
  },
};
