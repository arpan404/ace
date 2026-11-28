import { z } from "zod";

/** Build-time execution boundary. Debug and measurement run the loopback fixture; production never does. */
const ExecutionModeSchema = z.enum(["debug-fixture", "measurement-fixture", "production"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type FixtureMode = Exclude<ExecutionMode, "production">;

/** Parse a native-reported mode. Unknown values and JS/native mismatches fail closed. */
export function parseExecutionMode(value: unknown): ExecutionMode {
  return ExecutionModeSchema.parse(value);
}

/** Only debug and measurement builds carry the fixture transport and input hooks. */
export function isFixtureMode(mode: ExecutionMode): mode is FixtureMode {
  return mode !== "production";
}

/** The bundled JS must agree with the native build type before any transport starts. */
export function assertBundleMatchesMode(mode: FixtureMode, bundledDev: boolean): void {
  if (mode === "debug-fixture" && !bundledDev)
    throw new Error("The debug fixture requires a development bundle.");
  if (mode === "measurement-fixture" && bundledDev)
    throw new Error("The measurement fixture requires an optimized bundle.");
}

/** Bind a raw native mode fetch to a validated reader; the fetcher stays injectable for tests. */
export function createExecutionModeReader(fetchRawMode: () => unknown): () => ExecutionMode {
  return () => parseExecutionMode(fetchRawMode());
}
