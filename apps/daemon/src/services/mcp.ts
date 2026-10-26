import { createTextRedactor } from "@ace/redaction";
import { htmlPublication } from "../html-publication.ts";
import { imagePublication } from "../image-publication.ts";
import { logError } from "@ace/diagnostics";
import { toolResultObserver } from "../tool-result-mcp.ts";
import { providerMcpSources } from "../provider-mcp-sources.ts";
import { measurementObserver } from "../measurement-mcp.ts";
import {
  type CallObserver,
  agentControlToolkit,
  knowledgeToolkit,
  guideToolkit,
  PublicToolError,
} from "@ace/mcp-server";
import { builtinGuides } from "@ace/plugins";
import { devicesToolkit } from "@ace/devices/tools";
import { browserToolkit } from "../browser-toolkit.ts";
import { computerToolkit, screenToolkit } from "@ace/screen";
import { handoffToolkit } from "./handoff-tools.ts";
import { startDaemonMcp } from "../mcp.ts";
import { toolFailureReporter } from "../tool-failure-log.ts";
import { hostname } from "node:os";
import { mcpAwareness } from "../mcp-awareness.ts";
import { knowledgePort } from "../knowledge.ts";
import { Asks } from "../asks.ts";
import { BrowserHelp } from "../browser-help.ts";
import { browserHelpTab, browserHelpToolkit } from "../browser-help-tool.ts";
import { GitService } from "@ace/git";
import type { ServiceContext } from "./types.ts";
export async function startMcp(context: ServiceContext): Promise<void> {
  const { options, store, resources, services } = context;
  const devices = services.devices;

  const asks = new Asks({
    store,
    engine: () => services.engine,
    id: context.id,
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
  });
  services.asks = asks;
  const browser = services.browser;
  const help = browser
    ? new BrowserHelp({
        store,
        engine: () => services.engine,
        tab: browserHelpTab(browser),
        id: context.id,
        schedule: (run, ms) => {
          const timer = setTimeout(run, ms);
          timer.unref();
          return () => clearTimeout(timer);
        },
      })
    : undefined;
  if (help) services.browserHelp = help;
  const contextGit = new GitService({ timeoutMs: 10_000 });
  resources.own(() => contextGit.close());
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
  const knowledge = knowledgePort({
    store,
    projects: () => services.projects?.catalog,
    delegations: () => services.agentControl?.delegations,
    prStatus: async (thread, cwd) =>
      (await services.workspaceActions?.forge.status(thread, cwd)) ?? null,
    git: contextGit,
    failures: (sessionId) => services.mcp?.failures(sessionId) ?? [],
    asks,
    now: context.now,
    id: context.id,
  });
  const mcp = await startDaemonMcp(
    store,
    [
      htmlPublication({
        store,
        context: () => services.context,
        now: context.now,
        id: context.id,
        redactTitle: createTextRedactor({ env: process.env }),
      }),
      imagePublication({
        store,
        context: () => services.context,
        now: context.now,
        id: context.id,
        redactText: createTextRedactor({ env: process.env }),
      }),
      handoffToolkit(store),
      // The shipped skills, on demand, for every provider (Claude and Codex also get them natively).
      guideToolkit(await builtinGuides()),
      knowledgeToolkit(knowledge),
      agentControlToolkit({
        async execute(caller, operation, signal) {
          return services.agentControl
            ? services.agentControl.port.execute(caller, operation, signal)
            : { ok: false, code: "unsupported" };
        },
      }),
      ...(options.toolkits ?? []),
      ...(services.browser
        ? [
            browserToolkit(
              services.browser,
              store,
              async (call, { caller, signal }) => {
                const machines = services.machines;
                if (!machines) throw new PublicToolError("machine_unavailable");
                return machines.caller.browser(caller, call.machine, call.tool, call.args, {
                  timeoutMs: call.timeoutMs,
                  signal,
                });
              },
              userBrowserTools(services),
            ),
          ]
        : []),
      ...(help ? [browserHelpToolkit(help)] : []),
      // Registered at startup; the devices implementation loads on an agent's first call.
      ...(devices ? [devicesToolkit(() => devices.load())] : []),
      // Agents use the background engine on macOS and Linux; Windows keeps the session tools.
      ...(services.computer
        ? [
            computerToolkit(services.computer, {
              platform: process.platform === "linux" ? "linux" : "macos",
              // Read on every call, so a change in Settings applies to the next one.
              blockedApps: async () =>
                (await services.settings?.get("computer.blockedApps"))?.value ?? [],
              using: (threadId, app) =>
                services.computerUsing?.begin(ThreadId.parse(threadId), app) ?? (() => {}),
            }),
          ]
        : services.screen
          ? [screenToolkit(services.screen)]
          : []),
    ],
    observations,
    (caller) => {
      const thread = store.getThread(caller.threadId);
      const project = thread && store.getWorkspace(thread.workspaceId);
      return {
        // Report the thread's own native selector; a fixed placeholder misleads agents.
        access: thread?.permission?.effective ?? null,
        ...(thread && project ? { project: { id: thread.workspaceId, name: project.name } } : {}),
        // Providers with their own ask tool keep it; delegated children and Cursor get ask.
        askAvailable:
          thread?.provider === "cursor" ||
          !!services.agentControl?.delegations.journal.get(caller.threadId),
        disabled: {
          ...(!services.browser
            ? { browser: "ace's built-in browser failed to start in this daemon." }
            : {}),
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
      };
    },
    mcpAwareness({
      store,
      delegations: () => services.agentControl?.delegations,
      notes: (workspace) =>
        (services.projects?.catalog.get(workspace).notes ?? []).map((note) => note.text),
      machine: hostname(),
      roles: () => services.roles?.current() ?? {},
    }),
    knowledge,
    toolFailureReporter(context.log, context.id),
  );
  resources.own(() => mcp.close());
  services.mcp = mcp;
  // Turning computer use or devices on or off changes which ace tools are offered.
  if (services.screen) resources.own(services.screen.watchEnabled(mcp.toolsChanged));
  if (services.devices) resources.own(services.devices.watchEnabled(mcp.toolsChanged));
  // An agent that carries on (a new turn) no longer waits on a help request nobody answered.
  if (help)
    resources.own(
      store.subscribe((events) => {
        for (const { threadId, payload } of events)
          if (payload.type === "run.started") help.withdrawIdle(threadId);
      }),
    );
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
import { McpProviderRequest, ThreadId, type McpSources } from "@ace/protocol";
const mcpTypes = new Set<string>(
  McpProviderRequest.options.map((option) => option.shape.type.value),
);
const isMcp = (message: { type: string }): message is McpProviderRequest =>
  mcpTypes.has(message.type);
export function createMcpSession(context: SocketContext): SocketService {
  const { options, authorize, connected, send, fail, canReadThread, tasks } = context;
  const lifetime = new AbortController();
  let pending = 0;
  const nativeTasks = new Set<Promise<unknown>>();
  return {
    handle(message) {
      if (!isMcp(message)) return false;
      const reading = ["mcp.status", "mcp.sources", "mcp.provider.sources"].includes(message.type);
      if (
        !authorize(reading ? "read" : "operate") ||
        ("threadId" in message && !canReadThread(message.threadId))
      ) {
        fail("forbidden", "Thread MCP scope required", false, { requestId: message.requestId });
        return true;
      }
      if (pending >= 8 || nativeTasks.size >= 8) {
        fail("mcp_busy", "Provider MCP controls are busy", false, { requestId: message.requestId });
        return true;
      }
      pending++;
      const deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120_000)]);
      const control = async <T>(operation: Promise<T>): Promise<T> => {
        nativeTasks.add(operation);
        void operation.finally(() => nativeTasks.delete(operation)).catch(() => {});
        deadline.throwIfAborted();
        let abort: (() => void) | undefined;
        try {
          return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
              abort = () => reject(new Error("Provider MCP controls cancelled"));
              deadline.addEventListener("abort", abort, { once: true });
            }),
          ]);
        } finally {
          if (abort) deadline.removeEventListener("abort", abort);
        }
      };
      const task = (async () => {
        // A provider-wide request (Settings) reaches the provider's latest live session it may read.
        const scope =
          "threadId" in message ? { threadId: message.threadId } : { provider: message.provider };
        const live = () =>
          "threadId" in message
            ? options.mcp?.providers.require(message.threadId)
            : options.mcp?.providers.latest(message.provider, canReadThread);
        const reply = (result: unknown) => {
          if (connected())
            send({ type: "mcp.result", ...scope, requestId: message.requestId, result });
        };
        try {
          if (message.type === "mcp.sources" || message.type === "mcp.provider.sources") {
            let controls;
            try {
              controls = live();
            } catch {
              /* An idle provider has no live catalog. */
            }
            const result: McpSources = {
              // Older clients still read this field; ace's own tools live in the side panel.
              groups: [],
              servers: controls ? providerMcpSources(await control(controls.status())) : [],
              live: Boolean(controls),
              canAdd: Boolean(controls?.add),
              appliesNextTurn: controls?.appliesNextTurn ?? false,
            };
            reply(result);
            return;
          }
          if ("name" in message && message.name === "ace")
            throw new Error("ace owns this MCP connection");
          const controls = live();
          if (!controls) throw new Error("Provider MCP session unavailable");
          let result: unknown;
          switch (message.type) {
            case "mcp.add":
            case "mcp.provider.add":
              if (!controls.add)
                throw new Error("Adding MCP servers is unavailable for this provider");
              if (
                providerMcpSources(await control(controls.status())).some(
                  (server) => server.name === message.name,
                )
              )
                throw new Error("An MCP server already uses that name");
              await control(controls.add(message.name, message.server));
              result = null;
              break;
            case "mcp.status":
              result = providerMcpSources(await control(controls.status()));
              break;
            case "mcp.replace":
              result = await control(controls.replace(message.servers));
              break;
            case "mcp.reconnect":
            case "mcp.provider.reconnect":
              result = await control(controls.reconnect(message.name));
              break;
            case "mcp.enable":
            case "mcp.provider.enable":
              result = await control(controls.enable(message.name));
              break;
            case "mcp.disable":
            case "mcp.provider.disable":
              result = await control(controls.disable(message.name));
              break;
          }
          reply(result ?? null);
        } catch {
          fail("mcp_failed", "Provider MCP control failed", false, {
            requestId: message.requestId,
          });
        }
      })().finally(() => {
        pending--;
      });
      tasks.add(task);
      void task.finally(() => tasks.delete(task)).catch(() => {});
      return true;
    },
    close() {
      lifetime.abort();
    },
  };
}

/** The person's own Chrome for agents, when the daemon runs "Use my Chrome" (ADR 0084). */
function userBrowserTools(
  services: Pick<Partial<import("./types.ts").Services>, "userBrowser" | "userBrowserSessions">,
): import("../browser-toolkit.ts").UserBrowserTools | undefined {
  const user = services.userBrowser;
  const sessions = services.userBrowserSessions;
  if (!user || !sessions) return undefined;
  return { sessions, available: () => user.backend.available() };
}
