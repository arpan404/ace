import { requireNativeModule } from "expo";
import { createExecutionModeReader, type ExecutionMode } from "./execution-mode.ts";

const native = requireNativeModule<{ getExecutionMode(): unknown }>("AceNative");

/** Validated native build mode. Throws when the bridge is missing or reports an unknown mode. */
export const readExecutionMode: () => ExecutionMode = createExecutionModeReader(() =>
  native.getExecutionMode(),
);

/**
 * Fail-closed fixture check for UI gates. Returns false when the bridge is
 * missing or reports production, so debug-only controls (stress, probe, spike)
 * stay visible in both fixture builds (debug and measurement, where __DEV__ is
 * false) and hidden in production.
 */
export function isInstrumentedBuild(): boolean {
  try {
    return readExecutionMode() !== "production";
  } catch {
    return false;
  }
}
