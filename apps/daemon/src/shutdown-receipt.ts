import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
export const ShutdownAdmission = z.object({
  stopping: z.literal(true),
  receiptId: z.string().min(1).max(128),
});
/**
 * A stop request's body (optional: older clients send none). `caller` is the requesting
 * process and its ancestors, by pid and kernel start: the daemon's shutdown never signals them,
 * so a stop asked from inside one of its provider's shells still gets its receipt.
 */
export const StopRequest = z.object({
  caller: z
    .array(z.object({ pid: z.number().int().positive(), start: z.string().min(1).max(128) }))
    .max(64)
    .optional(),
});
export const ShutdownReceipt = z.object({
  id: z.string().min(1).max(128),
  state: z.enum(["pending", "succeeded", "failed"]),
  at: z.number().finite(),
  error: z.string().max(256).optional(),
  /**
   * The daemon stopped, but couldn't account for every process its run started (a capture too
   * large to read whole, lineage past its limit): `ace stop` reports that as uncertain.
   */
  unaccounted: z.literal(true).optional(),
});
type Member = { pid: number; start: string };
export interface ShutdownControl {
  /**
   * The caller chain a request may spare: verified against the process that holds the
   * request's connection, never the client's word alone (`peer-process.ts`).
   */
  verifyCaller(
    hint: readonly Member[] | undefined,
    connection: { remotePort: number; localPort: number },
  ): Promise<Member[]>;
  request(body?: { caller?: Member[] }): z.infer<typeof ShutdownAdmission>;
  start(): void;
}
/** One bounded, correlated receipt is kept outside resources being disposed. */
export function shutdownControl(
  home: string,
  runtime: {
    id(): string;
    now(): number;
    close(): Promise<void>;
    /** The first accepted request's verified caller chain, before shutdown begins. */
    caller?(members: Member[]): void;
    verifyCaller?(
      hint: readonly Member[] | undefined,
      connection: { remotePort: number; localPort: number },
    ): Promise<Member[]>;
    /** Whether the shutdown couldn't account for every process its run started. */
    unaccounted?(): boolean;
  },
): ShutdownControl {
  const path = join(home, "daemon-shutdown.json");
  let id: string | undefined;
  let started = false;
  const write = (
    state: z.infer<typeof ShutdownReceipt>["state"],
    error?: string,
    unaccounted = false,
  ) => {
    const receipt = ShutdownReceipt.parse({
      id,
      state,
      at: runtime.now(),
      ...(error ? { error } : {}),
      ...(unaccounted ? { unaccounted: true } : {}),
    });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600, flag: "w" });
    renameSync(temporary, path);
  };
  return {
    verifyCaller: (hint, connection) =>
      runtime.verifyCaller ? runtime.verifyCaller(hint, connection) : Promise.resolve([]),
    request(body) {
      if (!id) {
        id = runtime.id();
        runtime.caller?.(body?.caller ?? []);
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
          () => write("succeeded", undefined, runtime.unaccounted?.() === true),
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
