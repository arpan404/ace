import { logError } from "@ace/diagnostics";
import { toolResultObserver } from "../tool-result-mcp.ts";
import { requestDeviceAccess } from "../device-access.ts";
import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import { providerMcpSources } from "../provider-mcp-sources.ts";
import { measurementObserver } from "../measurement-mcp.ts";
import { agentControlCall } from "./agent-control-failure.ts";
import { type CallObserver, agentControlToolkit } from "@ace/mcp-server";
import { devicesToolkit } from "@ace/devices";
import { browserToolkit } from "../browser-toolkit.ts";
import { screenToolkit } from "@ace/screen";
import { handoffToolkit } from "./handoff-tools.ts";
import { startDaemonMcp } from "../mcp.ts";
import type { ServiceContext } from "./types.ts";
export async function startMcp(context: ServiceContext): Promise<void> {
  const { options, store, resources, services } = context;

  const measurements = measurementObserver({
    store,
    now: context.now,
    id: context.id,
    context: () => services.context,
  });
  const results = toolResultObserver({
    store,
    now: context.now,
    id: context.id,
    context: () => services.context,
    screen: () => services.screen,
  });
  const observeCall: CallObserver = (name, input, call) => {
    const callbacks = [
      results.observeCall(name, input, call),
      measurements.observeCall(name, input, call),
    ];
    return async (result) => {
      for (const capture of callbacks) {
        try {
          await capture?.(result);
        } catch (error) {
          context.log.log("error", "MCP result capture failed", logError(error));
        }
      }
    };
  };
  const observations = {
    observeCall,
    lease(sessionId: string) {
      const stopMeasurement = measurements.lease(sessionId);
      const stopResult = results.lease(sessionId);
      return () => {
        stopMeasurement();
        stopResult();
      };
    },
  };
  resources.own(measurements.close);
  resources.own(results.close);
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
      ...(services.devices
        ? [
            devicesToolkit(services.devices, undefined, async (deviceId, caller, signal) => {
              const devices = services.devices;
              if (!devices) throw new Error("Devices unavailable");
              await requestDeviceAccess(
                devices,
                services.screenApprovals,
                deviceId,
                caller,
                signal,
              );
            }),
          ]
        : []),
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
      permissionMode: "ask",
      get screenApproved() {
        return services.screen?.hasAppApproval(caller) ?? false;
      },
      disabled: {
        ...(!services.screen?.isEnabled()
          ? {
              screen: "Computer use is disabled.",
            }
          : {}),
        ...(!services.devices?.isEnabled()
          ? {
              devices: "Devices are disabled.",
            }
          : {}),
      },
    }),
  );
  resources.own(() => mcp.close());
  services.mcp = mcp;
  if (services.devices) {
    resources.own(services.devices.watchEnabled(mcp.toolsChanged));
    const grants = new Map<string, string>();
    resources.own(
      services.devices.watch((state) => {
        const threadId = state.approved ? state.threadId : undefined;
        if (grants.get(state.device.id) !== threadId) {
          if (threadId) grants.set(state.device.id, threadId);
          else grants.delete(state.device.id);
          mcp.toolsChanged();
        }
      }),
    );
  }
  resources.own(
    store.subscribe((events) => {
      if (
        events.some(({ payload }) =>
          payload.type === "thread.updated"
            ? payload.permission !== undefined
            : ["run.started", "run.ended", "thread.client.updated"].includes(payload.type),
        )
      )
        mcp.toolsChanged();
    }),
  );
}

import type { SocketContext, SocketService } from "./socket.ts";
export function createMcpSession(context: SocketContext): SocketService {
  const { options, authorize, connected, send, fail, canReadThread } = context;
  return {
    async handle(message) {
      if (
        message.type !== "mcp.sources" &&
        message.type !== "mcp.add" &&
        message.type !== "mcp.status" &&
        message.type !== "mcp.replace" &&
        message.type !== "mcp.reconnect" &&
        message.type !== "mcp.enable" &&
        message.type !== "mcp.disable"
      )
        return false;
      if (
        !authorize(["mcp.status", "mcp.sources"].includes(message.type) ? "read" : "operate") ||
        !canReadThread(message.threadId)
      ) {
        fail("forbidden", "Thread MCP scope required", false, { requestId: message.requestId });
        return true;
      }
      try {
        if (message.type === "mcp.sources") {
          let controls;
          try {
            controls = options.mcp?.providers.require(message.threadId);
          } catch {
            /* An idle provider has no live catalog. */
          }
          const result = {
            groups: options.mcp?.groups?.(message.threadId, daemonMcpCapabilities(options)) ?? [],
            servers: controls ? providerMcpSources(await controls.status()) : [],
            live: Boolean(controls),
            canAdd: Boolean(controls?.add),
            appliesNextTurn: controls?.appliesNextTurn ?? false,
          };
          if (connected())
            send({
              type: "mcp.result",
              threadId: message.threadId,
              requestId: message.requestId,
              result,
            });
          return true;
        }
        if ("name" in message && message.name === "ace")
          throw new Error("ace owns this MCP connection");
        const controls = options.mcp?.providers.require(message.threadId);
        if (!controls) throw new Error("Provider MCP session unavailable");
        let result: unknown;
        switch (message.type) {
          case "mcp.add":
            if (!controls.add)
              throw new Error("Adding MCP servers is unavailable for this provider");
            if (
              providerMcpSources(await controls.status()).some(
                (server) => server.name === message.name,
              )
            )
              throw new Error("An MCP server already uses that name");
            await controls.add(message.name, message.server);
            result = null;
            break;
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
