import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { probeOutput } from "@ace/provider-kit/process";
import { z } from "zod";
export interface SqliteRuntime {
  probe: typeof probeOutput;
  deadlineMs: number;
}
const systemSqlite: SqliteRuntime = { probe: probeOutput, deadlineMs: 5000 };
export async function sqliteProbe(
  path: string,
  task: "integrity" | "pages",
  signal: AbortSignal,
  runtime: SqliteRuntime = systemSqlite,
): Promise<unknown> {
  const result = await runtime.probe(
    process.execPath,
    [fileURLToPath(new URL("./sqlite-process.ts", import.meta.url)), path, task],
    { signal, timeoutMs: runtime.deadlineMs, maxBytes: 1024 },
  );
  if (result.code !== 0) throw new Error("SQLite probe failed");
  const value: unknown = JSON.parse(result.stdout);
  return value;
}
export async function checkIntegrity(
  path: string,
  signal: AbortSignal,
  runtime: SqliteRuntime = systemSqlite,
): Promise<"ok" | "corrupt" | "missing" | "unavailable"> {
  try {
    await stat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
  try {
    return z.enum(["ok", "corrupt"]).parse(await sqliteProbe(path, "integrity", signal, runtime));
  } catch (error) {
    if (signal.aborted) throw error;
    return "unavailable";
  }
}
export async function sqliteSizes(path: string, signal: AbortSignal) {
  const [pages, wal] = await Promise.allSettled([
    sqliteProbe(path, "pages", signal).then((value) => z.number().int().nonnegative().parse(value)),
    stat(`${path}-wal`).then(
      (value) => value.size,
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
        throw error;
      },
    ),
  ]);
  return {
    pageBytes: pages.status === "fulfilled" ? pages.value : null,
    walBytes: wal.status === "fulfilled" ? wal.value : null,
  };
}
