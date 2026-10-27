import { z } from "zod";
import type { ModelImageRuntime, ToolContext, Toolkit } from "@ace/mcp-server";
import type { DevicesService } from "./service.ts";
import { agentOwner } from "./owner.ts";
import {
  routedSimSchemas,
  simToolMetadata,
  simSchemas,
  type SimToolName,
} from "./sim-schemas.ts";
import type { SimResult } from "./sim-tools.ts";

function content(result: SimResult) {
  if (result.kind === "json")
    return { content: [{ type: "text" as const, text: JSON.stringify(result.value) }] };
  return {
    content: [
      {
        type: "image" as const,
        data: result.image.payload.toString("base64"),
        mimeType: "image/jpeg",
      },
      { type: "text" as const, text: result.note },
    ],
  };
}

/**
 * Sends a sim_* tool to another linked machine's devices (ADR 0105). That machine runs it with its
 * own leases and grants; this side passes the tool and its arguments, without `machine`.
 */
export type DevicesMachineRoute = (
  call: { machine: string; tool: SimToolName; args: Record<string, unknown>; timeoutMs: number },
  context: ToolContext,
) => Promise<unknown>;
const Routed = z.object({ machine: z.string().optional() }).catchall(z.unknown());

/**
 * The sim_* tools. `service` is awaited on each call, so a host can register the tools at startup
 * and load the devices implementation only when an agent first uses one.
 */
export function devicesToolkit(
  service: DevicesService | (() => Promise<DevicesService>),
  imageRuntime?: ModelImageRuntime,
  /** With a route, every tool takes `machine` to use another linked machine's devices. */
  route?: DevicesMachineRoute,
): Toolkit {
  const current = typeof service === "function" ? service : async () => service;
  return {
    register(registry) {
      for (const key of Object.keys(simSchemas)) {
        const name = key as SimToolName;
        const metadata = simToolMetadata[name];
        const input = route ? routedSimSchemas[name] : simSchemas[name];
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
          async run(raw, context) {
            const { caller, signal } = context;
            const { machine, ...args } = Routed.parse(raw);
            if (route && machine !== undefined)
              return route(
                { machine, tool: name, args, timeoutMs: metadata.timeoutMs - 5_000 },
                context,
              );
            const actor = {
              kind: "agent" as const,
              owner: agentOwner(caller.threadId, caller.agentId),
              threadId: caller.threadId,
              agentId: caller.agentId,
            };
            const { callSimTool } = await import("./sim-tools.ts");
            return content(
              await callSimTool(await current(), name, args, actor, signal, imageRuntime),
            );
          },
        });
      }
    },
  };
}
