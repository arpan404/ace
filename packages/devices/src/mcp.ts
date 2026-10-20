import type { ModelImageRuntime, Toolkit } from "@ace/mcp-server";
import { type DevicesService, agentOwner } from "./service.ts";
import { simToolMetadata, simSchemas, type SimToolName } from "./sim-schemas.ts";
import { callSimTool, type SimResult } from "./sim-tools.ts";

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
            const actor = {
              kind: "agent" as const,
              owner: agentOwner(caller.threadId, caller.agentId),
              threadId: caller.threadId,
              agentId: caller.agentId,
            };
            return content(await callSimTool(service, name, args, actor, signal, imageRuntime));
          },
        });
      }
    },
  };
}
