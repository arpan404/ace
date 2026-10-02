import type { ScreenOperation, DeviceScope } from "@ace/protocol";

/** Host consent is administrative; reading an approved stream never grants control. */
export function screenScope(operation: ScreenOperation): DeviceScope {
  switch (operation.op) {
    case "enable":
    case "approve":
      return "admin";
    case "permissions":
    case "targets":
    case "sessions":
    case "subscribe":
    case "unsubscribe":
    case "simulators":
      return "read";
    default:
      return "operate";
  }
}
