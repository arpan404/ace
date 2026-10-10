import type { StartupRuntime } from "./services/startup.ts";

/** Shutdown leaves time to release the endpoint and lock before the desktop escalates. */
export async function shutdownStage(
  name: string,
  close: () => void | Promise<void>,
  milliseconds: number,
  schedule: StartupRuntime["schedule"],
): Promise<void> {
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = schedule(
      `shutdown:${name}`,
      () => reject(new Error(`Shutdown ${name} did not finish`)),
      milliseconds,
    );
  });
  try {
    await Promise.race([Promise.resolve().then(close), deadline]);
  } finally {
    cancel?.();
  }
}
