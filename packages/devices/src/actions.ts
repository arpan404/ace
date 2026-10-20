import type { DeviceOperation } from "@ace/protocol/devices";
import type { DevicePlatform } from "./platform.ts";
import type { DeviceSession } from "./session.ts";
import type { Actor } from "./lease.ts";
import { DeviceError } from "./sdk.ts";
import { boundedClipboard } from "./clipboard.ts";
import { keyRefusal } from "./key-support.ts";

/** All mutations share the queue's dispatch guard, including SDK lookups. */
export async function performDeviceAction(
  platform: DevicePlatform,
  session: DeviceSession,
  actor: Actor,
  operation: DeviceOperation,
  guard: () => void,
): Promise<unknown> {
  switch (operation.op) {
    case "clipboard.get":
      return session.capture?.clipboard
        ? boundedClipboard(await session.capture.clipboard.read(guard))
        : platform.clipboardRead(session.device, guard);
    case "clipboard.set":
      if (session.capture?.clipboard) await session.capture.clipboard.write(operation.text, guard);
      else await platform.clipboardWrite(session.device, operation.text, guard);
      break;
    case "boot":
      await platform.boot(session.device, guard);
      break;
    case "install":
      await platform.install(session.device, operation.path, guard);
      break;
    case "open_app":
      await platform.openApp(session.device, operation.appId, guard);
      break;
    case "open_url":
      await platform.openUrl(session.device, operation.url, guard);
      break;
    case "configure":
      await platform.configure(session.device, operation.settings, guard);
      break;
    case "input":
      if (operation.input.kind === "key") {
        const refusal = keyRefusal(session.device.platform, operation.input.key);
        if (refusal) throw refusal;
      }
      if (
        operation.input.kind === "pointer" &&
        operation.input.pointerId &&
        !session.capture?.multiTouch
      )
        throw new DeviceError(
          "not_supported",
          "This device view supports one finger",
          "Send pointer input without a pointerId, or use one finger.",
        );
      if (session.capture?.input) {
        await session.capture.input(operation.input, guard);
        break;
      }
      await platform.input(
        session.device,
        operation.input,
        session.capture?.screenSessionId
          ? { sessionId: session.capture.screenSessionId, actor: actor.kind, owner: actor.owner }
          : undefined,
        guard,
      );
      if (operation.input.kind === "key" && operation.input.key === "rotate") {
        guard();
        await session.capture?.restart?.();
      }
      break;
    default:
      throw new DeviceError(
        "invalid_data",
        "Unsupported queued device action",
        "Use a device command.",
      );
  }
  return { completed: true };
}
