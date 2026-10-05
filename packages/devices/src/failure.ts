import { DeviceFailure } from "@ace/protocol/devices";
import { DeviceError } from "./sdk.ts";
import { screenFailure } from "./screen-failure.ts";

export function deviceFailure(error: unknown): DeviceFailure {
  const known = error instanceof DeviceError ? error : screenFailure(error);
  return known
    ? DeviceFailure.parse({
        code: known.code,
        message: known.message.slice(0, 2048),
        hint: known.hint.slice(0, 2048),
        ...(known.permission ? { permission: known.permission } : {}),
      })
    : {
        code: "command_failed",
        message: error instanceof Error ? error.message.slice(0, 2048) : "Device operation failed",
        hint: "Check installed tools and device state, then retry.",
      };
}
