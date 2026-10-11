import type { StartupRuntime } from "./services/startup.ts";
import type { DeliveryRuntime } from "./delivery-runtime.ts";

/** Bounds ownership drain without disguising an incomplete cleanup as success. */
export async function shutdownDeadline<T>(
  name: string,
  task: Promise<T>,
  delay: DeliveryRuntime["delay"],
  milliseconds: number,
): Promise<T> {
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = delay(() => reject(new Error(`${name} shutdown deadline exceeded`)), milliseconds);
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    cancel?.();
  }
}

export function shutdownStage(
  name: string,
  close: () => void | Promise<void>,
  milliseconds: number,
  schedule: StartupRuntime["schedule"],
): Promise<void> {
  return shutdownDeadline(
    name,
    Promise.resolve().then(close),
    (expire, ms) => schedule(`shutdown:${name}`, expire, ms),
    milliseconds,
  );
}
