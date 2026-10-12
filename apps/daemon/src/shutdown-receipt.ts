import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
export const ShutdownAdmission = z.object({
  stopping: z.literal(true),
  receiptId: z.string().min(1).max(128),
});
export const ShutdownReceipt = z.object({
  id: z.string().min(1).max(128),
  state: z.enum(["pending", "succeeded", "failed"]),
  at: z.number().finite(),
  error: z.string().max(256).optional(),
});
export interface ShutdownControl {
  request(): z.infer<typeof ShutdownAdmission>;
  start(): void;
}
/** One bounded, correlated receipt is kept outside resources being disposed. */
export function shutdownControl(
  home: string,
  runtime: { id(): string; now(): number; close(): Promise<void> },
): ShutdownControl {
  const path = join(home, "daemon-shutdown.json");
  let id: string | undefined;
  let started = false;
  const write = (state: z.infer<typeof ShutdownReceipt>["state"], error?: string) => {
    const receipt = ShutdownReceipt.parse({
      id,
      state,
      at: runtime.now(),
      ...(error ? { error } : {}),
    });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600, flag: "w" });
    renameSync(temporary, path);
  };
  return {
    request() {
      if (!id) {
        id = runtime.id();
        write("pending");
      }
      return ShutdownAdmission.parse({ stopping: true, receiptId: id });
    },
    start() {
      if (!id || started) return;
      started = true;
      void runtime
        .close()
        .then(
          () => write("succeeded"),
          () => write("failed", "Daemon cleanup failed or exceeded its deadline"),
        )
        .catch((error: unknown) => {
          // A failed receipt write is never evidence of successful shutdown.
          process.stderr.write(
            `${error instanceof Error ? error.message : "Shutdown receipt write failed"}\n`,
          );
          process.exitCode = 1;
        });
    },
  };
}
export function readShutdownReceipt(home: string) {
  try {
    return ShutdownReceipt.parse(
      JSON.parse(readFileSync(join(home, "daemon-shutdown.json"), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
