import { readFile } from "node:fs/promises";
import { readConfig, readHistoryInstances, startDaemon } from "@ace/daemon";

// Real composition, discovery, workers, store and engine. No scripted adapters.
const daemon = await startDaemon({
  config: readConfig(),
  history: { instances: readHistoryInstances() },
  engine: {
    // Includes automatic restart recovery: fail before opening any conversation session.
    sessionContext: async () => {
      throw new Error("Real smoke refuses provider conversation sessions");
    },
    preferences: { continueAfterRestart: false },
  },
});
const token = (await readFile(daemon.tokenPath, "utf8")).trim();
process.send?.({ type: "ready", url: daemon.url, token });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await daemon.close();
    process.exitCode = 0;
  } catch (error) {
    process.send?.({
      type: "shutdown-error",
      message: error instanceof Error ? error.message : String(error),
      causes:
        error instanceof AggregateError
          ? error.errors.map((cause: unknown) =>
              cause instanceof Error ? cause.message : String(cause),
            )
          : [],
    });
    process.exitCode = 1;
  }
  process.disconnect?.();
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.on("disconnect", () => void stop());
