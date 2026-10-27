import { requireNativeModule } from "expo";
import { createExecutionModeReader, type ExecutionMode } from "./execution-mode.ts";

const native = requireNativeModule<{ getExecutionMode(): unknown }>("AceNative");

/** Validated native build mode. Throws when the bridge is missing or reports an unknown mode. */
export const readExecutionMode: () => ExecutionMode = createExecutionModeReader(() =>
  native.getExecutionMode(),
);
