import { measurementObserver } from "../measurement-mcp.ts";
import { agentControlCall } from "./agent-control-failure.ts";
import { agentControlToolkit } from "@ace/mcp-server";
import { devicesToolkit } from "@ace/devices";
import { browserToolkit } from "../browser-toolkit.ts";
import { screenToolkit } from "@ace/screen";
import { handoffToolkit } from "./handoff-tools.ts";
import { startDaemonMcp } from "../mcp.ts";
import type { ServiceContext } from "./types.ts";
export async function startMcp(context: ServiceContext): Promise<void> {
  const { options, store, resources, services } = context;

  const observations = measurementObserver({
    store,
    now: context.now,
    id: context.id,
    context: () => services.context,
  });
  resources.own(observations.close);
  const mcp = await startDaemonMcp(
    store,
    [
      handoffToolkit(store),
      agentControlToolkit({
        async execute(caller, operation, signal) {
          return services.agentControl
            ? services.agentControl.port.execute(caller, operation, signal)
            : { ok: false, code: "unsupported" };
        },
      }),
      ...(options.toolkits ?? []),
      ...(services.browser ? [browserToolkit(services.browser, store)] : []),
      ...(services.devices ? [devicesToolkit(services.devices)] : []),
      ...(services.screen ? [screenToolkit(services.screen)] : []),
    ],
    async (intent, signal) =>
      agentControlCall(context, intent, "ace_spawn_agent", signal, async () => {
        signal.throwIfAborted();
        const parent = store.getThread(intent.threadId);
        if (!services.agentControl || !parent) throw new Error("Delegation unavailable");
        const request = {
          requestId: context.id(),
          provider: intent.input.provider ?? parent.provider,
          role: intent.input.name ?? "delegate",
          task: intent.input.task,
          wait: false,
          estimatedLoad: 0,
        };
        const model = await services.agentControl.delegations.prepareModels(intent, request);
        signal.throwIfAborted();
        const record = services.agentControl.delegations.delegate(intent, request, model);
        return { intentId: record.childId };
      }),
    observations,
    (caller) => ({
      permissionMode:
        services.engine?.permissionMode(caller.threadId) ??
        store.getThread(caller.threadId)?.permission?.effective ??
        null,
      disabled: {
        ...(!services.screen?.isEnabled()
          ? {
              screen:
                "Computer use is disabled. Ask the person to enable it in Settings → Computer use.",
            }
          : {}),
        ...(!services.devices?.isEnabled()
          ? {
              devices:
                "Devices are disabled. Ask the person to enable devices in the thread's Devices panel.",
            }
          : {}),
      },
    }),
  );
  resources.own(() => mcp.close());
  services.mcp = mcp;
}

import type { SocketContext, SocketService } from "./socket.ts";
export function createMcpSession(context: SocketContext): SocketService {
  const { options, authorize, connected, send, fail, canReadThread } = context;
  return {
    async handle(message) {
      if (
        message.type !== "mcp.status" &&
        message.type !== "mcp.replace" &&
        message.type !== "mcp.reconnect" &&
        message.type !== "mcp.enable" &&
        message.type !== "mcp.disable"
      )
        return false;
      if (
        !authorize(message.type === "mcp.status" ? "read" : "operate") ||
        !canReadThread(message.threadId)
      ) {
        fail("forbidden", "Thread MCP scope required");
        return true;
      }
      try {
        const controls = options.mcp?.providers.require(message.threadId);
        if (!controls) throw new Error("Provider MCP session unavailable");
        let result: unknown;
        switch (message.type) {
          case "mcp.status":
            result = await controls.status();
            break;
          case "mcp.replace":
            result = await controls.replace(message.servers);
            break;
          case "mcp.reconnect":
            result = await controls.reconnect(message.name);
            break;
          case "mcp.enable":
            result = await controls.enable(message.name);
            break;
          case "mcp.disable":
            result = await controls.disable(message.name);
            break;
        }
        if (connected())
          send({
            type: "mcp.result",
            threadId: message.threadId,
            requestId: message.requestId,
            result: result ?? null,
          });
      } catch (error) {
        fail(
          "mcp_failed",
          error instanceof Error ? error.message : "Provider MCP control failed",
          false,
          { requestId: message.requestId },
        );
      }
      return true;
    },
  };
}
