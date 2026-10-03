import { z } from "zod";
import { DeviceOperation, AppDeviceId } from "@ace/protocol/devices";
import { ScreenUITreeOptions, ScreenUIFindOptions, ScreenUIActOptions } from "@ace/protocol";
import type { Toolkit } from "@ace/mcp-server";
import { DevicesService, agentOwner, deviceFailure } from "./service.ts";

const target = z.strictObject({ deviceId: AppDeviceId });
const schemas = {
  device_list: z.strictObject({}),
  device_boot: target,
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
export function devicesToolkit(service: DevicesService): Toolkit {
  return {
    register(registry) {
      for (const [name, input] of Object.entries(schemas))
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
          description: `Use the approved in-app device: ${name.slice(7).replaceAll("_", " ")}. UI tree and find return bounded semantic refs; actions require a human-delegated lease.`,
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
                signal.throwIfAborted();
                return {
                  content: [
                    {
                      type: "image" as const,
                      data: frame.payload.toString("base64"),
                      mimeType: "image/jpeg",
                    },
                    {
                      type: "text" as const,
                      text: `Frame ${frame.header.sequence}, ${frame.header.width}x${frame.header.height}. Input uses target points; frame scale ${frame.header.scale ?? 1}. Prefer device_find and device_act.`,
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
              return {
                isError: true,
                content: [{ type: "text" as const, text: JSON.stringify(deviceFailure(error)) }],
              };
            } finally {
              signal.removeEventListener("abort", abort);
            }
          },
        });
    },
  };
}
