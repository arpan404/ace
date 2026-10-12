import { z } from "zod";
// Hold the real compaction helper at its process boundary, never on the daemon event loop.
process.once("message", (message: unknown) => {
  z.literal("compact").parse(message);
  process.disconnect?.();
  void import("./compaction-worker.ts").catch(() => {
    process.exitCode = 1;
  });
});
process.send?.("ready");
