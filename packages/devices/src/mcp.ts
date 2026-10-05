import { z } from "zod";
import { DeviceOperation, AppDeviceId } from "@ace/protocol/devices";
import { ScreenUITreeOptions, ScreenUIFindOptions, ScreenUIActOptions } from "@ace/protocol";
import {
  modelImage,
  ModelImageError,
  PublicToolError,
  PublicToolCode,
  type ModelImageRuntime,
  type Toolkit,
} from "@ace/mcp-server";
import type { ApprovalTarget } from "@ace/protocol";
import { DevicesService, agentOwner, deviceFailure } from "./service.ts";

const target = z.strictObject({ deviceId: AppDeviceId });
const schemas = {
  device_list: z.strictObject({}),
  device_boot: target,
  device_start: target,
  device_stop: target,
  device_open_app: target.extend({ appId: z.string().min(1).max(256) }),
  device_open_url: target.extend({ url: z.string().min(1).max(4096) }),
  device_screenshot: target,
  device_ui_tree: target.extend(ScreenUITreeOptions.shape),
  device_find: target.extend(ScreenUIFindOptions.shape),
  device_act: target.extend(ScreenUIActOptions.shape),
  device_tap: target.extend({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    durationMs: z.number().int().min(1).max(10000).optional(),
  }),
  device_swipe: target.extend({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    toX: z.number().int().nonnegative(),
    toY: z.number().int().nonnegative(),
    durationMs: z.number().int().min(1).max(10000).default(500),
  }),
  device_type: target.extend({ text: z.string().max(4096) }),
  device_key: target.extend({ key: z.enum(["home", "back", "rotate", "enter", "power"]) }),
  device_logs: target.extend({ limit: z.number().int().min(1).max(256).default(100) }),
  device_record_start: target,
  device_record_stop: target,
  device_install: target.extend({ path: z.string().min(1).max(4096) }),
};
const operations: Record<string, string> = {
  device_list: "list",
  device_boot: "boot",
  device_start: "start",
  device_stop: "stop",
  device_open_app: "open_app",
  device_open_url: "open_url",
  device_ui_tree: "ui.tree",
  device_find: "ui.find",
  device_act: "ui.act",
  device_logs: "logs",
  device_record_start: "record.start",
  device_record_stop: "record.stop",
  device_install: "install",
};
const actions = new Map(
  Object.entries({
    device_list: {
      riskClass: "read-only",
      description: "List available in-app devices and their current status.",
    },
    device_start: {
      riskClass: "read-only",
      description:
        "Start capture of a device approved for this thread. Call before device_screenshot. Requires installed capture tools and OS permission; does not grant input control.",
    },
    device_stop: {
      riskClass: "external-effect",
      description: "Stop device capture. Requires the agent controller lease.",
    },
    device_boot: {
      riskClass: "external-effect",
      description: "Boot the selected emulator or simulator.",
    },
    device_open_app: {
      riskClass: "external-effect",
      description: "Launch the selected app on the approved device.",
    },
    device_open_url: {
      riskClass: "external-effect",
      description: "Open a URL on the approved device.",
    },
    device_screenshot: {
      riskClass: "read-only",
      description: "Read a screenshot of the approved device.",
    },
    device_ui_tree: {
      riskClass: "read-only",
      description: "Read the approved device's bounded accessibility tree and semantic refs.",
    },
    device_find: {
      riskClass: "read-only",
      description: "Find accessible elements on the approved device without changing them.",
    },
    device_act: {
      riskClass: "external-effect",
      description: "Perform an accessibility action on the approved device element.",
    },
    device_tap: {
      riskClass: "external-effect",
      description: "Tap or long-press the selected point on the approved device.",
    },
    device_swipe: {
      riskClass: "external-effect",
      description: "Swipe between selected points on the approved device.",
    },
    device_type: {
      riskClass: "external-effect",
      description: "Type text into the approved device's focused control.",
    },
    device_key: {
      riskClass: "external-effect",
      description: "Send a navigation, rotation or power key to the approved device.",
    },
    device_logs: {
      riskClass: "read-only",
      description: "Read a bounded tail of the approved device's logs.",
    },
    device_record_start: {
      riskClass: "external-effect",
      description: "Start recording the approved device's screen.",
    },
    device_record_stop: {
      riskClass: "external-effect",
      description: "Stop the device recording and publish its artifact.",
    },
    device_install: {
      riskClass: "external-effect",
      description: "Install the selected application package on the approved device.",
    },
  } satisfies Record<
    keyof typeof schemas,
    { riskClass: NonNullable<ApprovalTarget["riskClass"]>; description: string }
  >),
);
export function devicesToolkit(service: DevicesService, imageRuntime?: ModelImageRuntime): Toolkit {
  return {
    register(registry) {
      for (const [name, input] of Object.entries(schemas)) {
        const action = actions.get(name);
        if (!action) throw new Error("Device action metadata missing");
        registry.registerContent({
          name,
          input,
          capability: "devices",
          timeoutMs:
            name === "device_record_stop"
              ? 180000
              : name === "device_boot"
                ? 250000
                : name === "device_install"
                  ? 120000
                  : 30000,
          description: action.description,
          riskClass: action.riskClass,
          async run(args, { caller, signal }) {
            const owner = agentOwner(caller.threadId, caller.agentId);
            const actor = {
              kind: "agent" as const,
              owner,
              threadId: caller.threadId,
              agentId: caller.agentId,
            };
            signal.throwIfAborted();
            const abort = () => service.disconnect(owner);
            signal.addEventListener("abort", abort, { once: true });
            try {
              if (name === "device_screenshot") {
                const { deviceId } = target.parse(args);
                const frame = await service.screenshot(deviceId, actor);
                const image = await modelImage(
                  { payload: frame.payload, ...frame.header },
                  signal,
                  imageRuntime,
                );
                signal.throwIfAborted();
                return {
                  content: [
                    {
                      type: "image" as const,
                      data: image.payload.toString("base64"),
                      mimeType: "image/jpeg",
                    },
                    {
                      type: "text" as const,
                      text: `Frame ${frame.header.sequence}, ${image.width}x${image.height}. Input uses target points; frame scale ${image.scale}. Prefer device_find and device_act.`,
                    },
                  ],
                };
              }
              const kind =
                name === "device_tap"
                  ? "durationMs" in args && args.durationMs
                    ? "longPress"
                    : "tap"
                  : name === "device_swipe"
                    ? "swipe"
                    : name === "device_type"
                      ? "type"
                      : name === "device_key"
                        ? "key"
                        : undefined;
              const operation = DeviceOperation.parse(
                kind
                  ? { op: "input", ...args, input: { kind, ...args } }
                  : { op: operations[name], ...args },
              );
              const data = await service.request(operation, actor);
              signal.throwIfAborted();
              return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
            } catch (error) {
              if (error instanceof ModelImageError) throw error;
              const failure = deviceFailure(error);
              const code = PublicToolCode.safeParse(failure.code);
              throw new PublicToolError(
                code.success ? code.data : "command_failed",
                failure.permission,
              );
            } finally {
              signal.removeEventListener("abort", abort);
            }
          },
        });
      }
    },
  };
}
