import { DeviceFailure } from "@ace/protocol/devices";
import { DeviceError } from "./sdk.ts";
export function deviceFailure(error: unknown): DeviceFailure {
  return error instanceof DeviceError
    ? DeviceFailure.parse({
        code: error.code,
        message: error.message.slice(0, 2048),
        hint: error.hint.slice(0, 2048),
      })
    : {
        code: "command_failed",
        message: error instanceof Error ? error.message.slice(0, 2048) : "Device operation failed",
        hint: "Check installed tools and device state, then retry.",
      };
}
