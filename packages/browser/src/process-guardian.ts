import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Own the private Chromium profile before launch, including abrupt daemon death. */
export async function guardChromium(profile: string) {
  const child = fork(
    fileURLToPath(new URL("./process-guardian-entry.ts", import.meta.url)),
    [profile],
    {
      execArgv: [],
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE },
    },
  );
  let closing = false;
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  child.once("message", (value: unknown) => {
    if (value === "ready") ready.resolve();
    else ready.reject(new Error("Invalid Chromium guardian readiness"));
  });
  child.once("error", (error) => {
    ready.reject(error);
    exited.reject(error);
  });
  child.once("exit", (code) => {
    ready.reject(new Error("Chromium guardian exited before launch"));
    if (code === 0 && closing) exited.resolve();
    else exited.reject(new Error("Chromium guardian cleanup failed"));
  });
  // Keep failures observed even before launch reaches cleanup.
  void exited.promise.catch(() => {});
  try {
    await ready.promise;
  } catch (error) {
    closing = true;
    if (child.connected) child.disconnect();
    await exited.promise.catch(() => {});
    throw error;
  }
  return {
    async close() {
      closing = true;
      if (child.connected) child.disconnect();
      await exited.promise;
    },
  };
}
