import { z } from "zod";
import { DeviceOperation, AppDevice } from "@ace/protocol/devices";
import {
  modelImage,
  ModelImageError,
  PublicToolError,
  PublicToolCode,
  type ModelImageRuntime,
  type Toolkit,
} from "@ace/mcp-server";
import { uiReadRequest } from "@ace/screen";
import { DevicesService, agentOwner, deviceFailure } from "./service.ts";
import { simSchemas, simToolMetadata, type SimToolName } from "./sim-schemas.ts";

type Actor = Parameters<DevicesService["request"]>[1];
type SimAct = z.output<typeof simSchemas.sim_act>;
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const Listed = z.object({ devices: z.array(z.looseObject({ id: z.string(), state: z.string() })) });

/** The device operation one sim_act call performs. */
function actOperation(args: SimAct): unknown {
  const deviceId = args.simId;
  switch (args.action) {
    case "ui":
      return {
        op: "ui.act",
        deviceId,
        ref: args.ref,
        action: args.uiAction ?? "press",
        ...(args.value !== undefined ? { value: args.value } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
      };
    case "tap":
      return { op: "input", deviceId, input: { kind: "tap", x: args.x, y: args.y } };
    case "long_press":
      return {
        op: "input",
        deviceId,
        input: { kind: "longPress", x: args.x, y: args.y, durationMs: args.durationMs },
      };
    case "swipe":
      return {
        op: "input",
        deviceId,
        input: {
          kind: "swipe",
          x: args.x,
          y: args.y,
          toX: args.toX,
          toY: args.toY,
          durationMs: args.durationMs,
        },
      };
    case "type":
      return { op: "input", deviceId, input: { kind: "type", text: args.text } };
    case "key":
      return { op: "input", deviceId, input: { kind: "key", key: args.key } };
    case "open_app":
      return { op: "open_app", deviceId, appId: args.appId };
    case "open_url":
      return { op: "open_url", deviceId, url: args.url };
    case "install":
      return { op: "install", deviceId, path: args.path };
    case "record_start":
      return { op: "record.start", deviceId };
    case "record_stop":
      return { op: "record.stop", deviceId };
  }
}

/** What an agent needs after taking or releasing a simulator, not the full device state. */
function summary(raw: unknown) {
  const state = z
    .looseObject({ device: AppDevice, lifecycle: z.string(), controller: z.string() })
    .safeParse(raw);
  if (!state.success) return raw;
  const { device, lifecycle, controller } = state.data;
  return { simId: device.id, name: device.name, state: device.state, lifecycle, controller };
}

async function run(
  service: DevicesService,
  name: SimToolName,
  args: Record<string, unknown>,
  actor: Actor & { kind: "agent" },
  signal: AbortSignal,
  imageRuntime: ModelImageRuntime | undefined,
) {
  switch (name) {
    case "sim_list":
      return text(await service.request(DeviceOperation.parse({ op: "list" }), actor));
    case "sim_start": {
      const { simId, boot } = simSchemas.sim_start.parse(args);
      // Taking a simulator needs no prompt; the provider's permission mode governs the call.
      await service.claimForAgent(simId, { ...actor, guard: () => signal.throwIfAborted() });
      if (boot) {
        const listed = Listed.parse(await service.request({ op: "list" }, actor));
        if (listed.devices.find((device) => device.id === simId)?.state !== "booted")
          await service.request(DeviceOperation.parse({ op: "boot", deviceId: simId }), actor);
      }
      const state = await service.request(
        DeviceOperation.parse({ op: "start", deviceId: simId }),
        actor,
      );
      return text(summary(state));
    }
    case "sim_stop": {
      const { simId } = simSchemas.sim_stop.parse(args);
      return text(
        summary(
          await service.request(DeviceOperation.parse({ op: "stop", deviceId: simId }), actor),
        ),
      );
    }
    case "sim_ui": {
      const { simId, ...read } = simSchemas.sim_ui.parse(args);
      const request = uiReadRequest(read);
      const operation =
        request.kind === "find"
          ? { op: "ui.find", deviceId: simId, ...request.options }
          : { op: "ui.tree", deviceId: simId, ...request.options };
      return text(await service.request(DeviceOperation.parse(operation), actor));
    }
    case "sim_act":
      return text(
        await service.request(
          DeviceOperation.parse(actOperation(simSchemas.sim_act.parse(args))),
          actor,
        ),
      );
    case "sim_logs": {
      const { simId, limit } = simSchemas.sim_logs.parse(args);
      return text(
        await service.request(DeviceOperation.parse({ op: "logs", deviceId: simId, limit }), actor),
      );
    }
    case "sim_screenshot": {
      const { simId } = simSchemas.sim_screenshot.parse(args);
      const frame = await service.screenshot(simId, actor);
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
            text: `${simId} frame ${frame.header.sequence}, ${image.width}x${image.height}. Divide image pixels by scale ${image.scale} for sim_act points; prefer sim_ui refs.`,
          },
        ],
      };
    }
  }
}

export function devicesToolkit(service: DevicesService, imageRuntime?: ModelImageRuntime): Toolkit {
  return {
    register(registry) {
      for (const [key, input] of Object.entries(simSchemas)) {
        const name = key as SimToolName;
        const metadata = simToolMetadata[name];
        registry.registerContent({
          name,
          input,
          title: metadata.title,
          description: metadata.description,
          riskClass: metadata.riskClass,
          // Simulators run on this machine; nothing here reaches outside systems.
          openWorld: false,
          capability: "devices",
          timeoutMs: metadata.timeoutMs,
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
              const result = await run(
                service,
                name,
                z.record(z.string(), z.unknown()).parse(args),
                actor,
                signal,
                imageRuntime,
              );
              signal.throwIfAborted();
              return result;
            } catch (error) {
              if (error instanceof ModelImageError || error instanceof PublicToolError) throw error;
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
