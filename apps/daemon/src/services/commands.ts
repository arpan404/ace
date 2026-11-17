import { logFields } from "@ace/diagnostics";
import { discoverClaudePlugins } from "../catalog-claude-discovery.ts";
import { discoverCodexExtensions } from "../catalog-discovery.ts";
import { createCatalogSession } from "./catalog.ts";
import { realpath } from "node:fs/promises";
import { repeatableWarmup } from "./warmup.ts";
import { AccountProvider } from "@ace/protocol/accounts";
import { pickInstance } from "@ace/accounts";
import { createDaemonCommandLibrary, defaultCommandInstances } from "../command-library.ts";
import { connectDaemonCommandEvents, type CommandEventSource } from "../command-events.ts";
import { PromptFiles, type ProviderInstance } from "@ace/commands";
import { join } from "node:path";
import { builtinSkillsDirectory } from "@ace/plugins";
import { WorkspaceId, type Thread } from "@ace/protocol";
import type { ServiceContext } from "./types.ts";
import { createDaemonSkillLibrary, type DaemonSkillOptions } from "../skill-library.ts";
import { readSkillUsage } from "../skill-usage.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export interface DaemonCommandIntegration {
  instances?: readonly ProviderInstance[];
  instanceForThread?: (thread: Thread) => string;
  events?: CommandEventSource;
  skills?: DaemonSkillOptions;
}
/**
 * The library and its owners are built once, here, so a failure to build is a failed start the
 * ordinary retry handles. Only waiting for the account registry can fail afterwards, and that
 * wait is the repeatable warmup. It publishes only after the wait succeeds and only once, so a run
 * after a failure never registers anything twice.
 */
export async function startCommands(context: ServiceContext): Promise<void> {
  const publish = buildCommands(context);
  const { services, signal } = context;
  const initialization = repeatableWarmup(context, "commands", async () => {
    await services.accountRegistry?.ready;
    signal.throwIfAborted();
    publish();
  });
  context.resources.own(() => initialization, "commands startup");
}
function buildCommands({
  store,
  config,
  options,
  resources,
  services,
  now,
  signal,
  id,
  log,
}: ServiceContext) {
  const promptFiles = new PromptFiles({
    globalRoot: config.dataDir,
    projectRoot: (workspaceId) => store.getWorkspacePath(WorkspaceId.parse(workspaceId)),
    id,
  });
  services.promptFiles = promptFiles;
  resources.own(() => promptFiles.close(), "prompt files");
  const integration = options.commands ?? {};
  const skillLibrary = createDaemonSkillLibrary({
    dataDir: config.dataDir,
    env: process.env,
    workspace: (workspaceId) => {
      const parsed = WorkspaceId.safeParse(workspaceId);
      return parsed.success ? store.getWorkspacePath(parsed.data) : undefined;
    },
    // Plugins start after commands: read when asked, not when built.
    pluginEntries: async () => (await services.plugins?.extensions("claude")) ?? [],
    options: integration.skills,
    usage: async (names) => readSkillUsage((sql) => store.statement(sql), names),
    report: (message, detail) => log.log("warn", message, logFields([["detail", detail]])),
    now,
    id,
  });
  // Recovery is queued ahead of skill requests and retries in the background; it never blocks
  // the command library from starting.
  void skillLibrary.start();
  services.skillLibrary = skillLibrary;
  resources.own(() => skillLibrary.close(), "skill library");
  const registered = () => services.accountRegistry?.list() ?? [];
  const defaults = defaultCommandInstances(process.env);
  let discoveryTail: Promise<unknown> = Promise.resolve();
  let pendingDiscovery = 0;
  const library = createDaemonCommandLibrary(
    store,
    config.dataDir,
    integration.instances ??
      (() => [
        ...defaults,
        ...registered()
          .filter(({ instance }) => !defaults.some((d) => d.id === instance.id))
          .map(({ instance }) => ({
            id: instance.id,
            provider: instance.provider,
            skillsHome: instance.implicit
              ? defaults.find((d) => d.provider === instance.provider)?.skillsHome
              : undefined,
            home: instance.implicit
              ? (defaults.find((d) => d.provider === instance.provider)?.home ?? instance.homeDir)
              : instance.provider === "opencode"
                ? join(
                    instance.env.XDG_CONFIG_HOME ?? join(instance.homeDir, "user/.config"),
                    "opencode",
                  )
                : instance.homeDir,
          })),
      ]),
    process.env,
    integration.instanceForThread ??
      ((thread) => {
        const row = services.engine
          ? store.atomic((db) =>
              db
                .prepare("SELECT instance_id FROM engine_sessions WHERE thread_id=?")
                .get(thread.id),
            )
          : undefined;
        if (typeof row?.instance_id === "string") return row.instance_id;
        const provider = AccountProvider.safeParse(thread.provider);
        const selected = provider.success
          ? pickInstance(
              { provider: provider.data, role: "worker", estimatedLoad: 1 },
              registered(),
              now(),
            )
          : undefined;
        return selected?.id ?? thread.provider;
      }),
    now,
    async (ctx) => {
      const admitted = pendingDiscovery < 8;
      if (admitted) pendingDiscovery++;
      const discover = admitted
        ? discoveryTail
            .then(async () => {
              if (!["codex", "claude"].includes(ctx.provider) || signal.aborted) return [];
              const instance =
                registered().find((i) => i.instance.id === ctx.instance)?.instance ??
                (ctx.instance === ctx.provider
                  ? registered().find(
                      (i) => i.instance.provider === ctx.provider && i.instance.implicit,
                    )?.instance
                  : undefined);
              if (!instance || integration.instances) return [];
              const env = { ...process.env, ...instance.env };
              const executable =
                services.providerConfigurations?.for(ctx.provider, instance.id)?.binaryPath ??
                ctx.provider;
              const probe =
                ctx.provider === "claude" ? discoverClaudePlugins : discoverCodexExtensions;
              return probe({ executable, cwd: ctx.workspace, env, signal }).catch(() => []);
            })
            .finally(() => {
              pendingDiscovery--;
            })
        : Promise.resolve([]);
      if (admitted) discoveryTail = discover.catch(() => {});
      return [
        ...(await discover),
        ...((await services.plugins?.extensions(ctx.provider)) ?? []),
        ...(services.automations?.catalog(ctx.provider, ctx.workspace) ?? []).map((a) => ({
          id: `ace:workflow:${a.id}`,
          kind: "workflow" as const,
          name: a.title,
          description: "Run this automation",
          source: { provider: "ace" as const, scope: "project" as const },
          invocation: { type: "action" as const, action: `automation.run:${a.id}` },
        })),
      ];
    },
    // Claude, Codex, OpenCode and Pi load the shipped skills natively and advertise them.
    { directory: builtinSkillsDirectory(), providers: ["cursor", "acp", "antigravity"] },
  );
  resources.own(() => library.close(), "command library");
  if (integration.events) {
    const disconnect = connectDaemonCommandEvents(library, integration.events);
    resources.onShutdown(disconnect);
  }
  /** Makes the library available, once the account registry has answered. Runs once. */
  let published = false;
  return () => {
    if (published) return;
    published = true;
    services.commands = library;
    const plugins = services.plugins;
    if (!plugins) return;
    resources.own(plugins.subscribeCatalog(() => skillLibrary.invalidate()));
    resources.own(plugins.subscribeCatalog(() => library.invalidateExtras()));
  };
}
export function createCommandsSession(context: SocketContext): SocketService {
  const catalog = createCatalogSession(context);
  return {
    close() {
      catalog.close?.();
    },
    async handle(message, socketDevice) {
      if (await catalog.handle?.(message, socketDevice)) return true;
      if (message.type !== "commands.list" && message.type !== "commands.resolve") return false;
      const reject = (code: string, detail: string) =>
        context.fail(code, detail, false, { requestId: message.requestId });
      if (message.type === "commands.list" && message.draft) {
        if (message.threadId) {
          reject("invalid_request", "Choose a thread or draft");
          return true;
        }
        const draft = message.draft;
        const device = context.device();
        try {
          if (
            !device ||
            !context.authorize("read") ||
            !context.options.context?.draftWorkspace ||
            !context.options.commands?.listDraft
          )
            throw new Error("Draft unavailable");
          const root = await context.options.context.draftWorkspace(device, draft.draftId);
          const workspace = context.options.store.getWorkspacePath(draft.workspaceId);
          if (!workspace || (await realpath(workspace)) !== root)
            throw new Error("Draft workspace mismatch");
          const result = await context.options.commands.listDraft(
            draft.draftId,
            {
              workspace: root,
              provider: draft.provider,
              instance: draft.instanceId ?? draft.provider,
            },
            message.query,
            message.limit,
          );
          if (
            context.connected() &&
            context.authorize("read") &&
            (await context.options.context.draftWorkspace(device, draft.draftId)) === root
          )
            context.send({ type: "commands.list.result", requestId: message.requestId, ...result });
        } catch {
          reject("draft_unavailable", "Draft or command catalog unavailable");
        }
        return true;
      }
      if (!message.threadId) {
        reject("invalid_request", "Thread or draft required");
        return true;
      }
      const threadId = message.threadId;
      const readable = () =>
        context.connected() && context.authorize("read") && context.canReadThread(threadId);
      if (!context.authorize("read")) reject("forbidden", "Read scope required");
      else if (!context.options.store.getThread(threadId) || !context.canReadThread(threadId))
        reject("read_denied", "Thread is not readable");
      else if (!context.options.commands)
        reject("commands_unavailable", "Command catalog unavailable");
      else
        try {
          if (message.type === "commands.list") {
            const result = await context.options.commands.list(
              threadId,
              message.query,
              message.limit,
            );
            if (readable())
              context.send({
                type: "commands.list.result",
                requestId: message.requestId,
                ...result,
              });
          } else {
            const result = await context.options.commands.resolve(
              threadId,
              message.commandId,
              message.arguments,
              message.positional,
            );
            if (readable())
              context.send({
                type: "commands.resolve.result",
                requestId: message.requestId,
                result,
              });
          }
        } catch {
          reject("commands_failed", "Unknown thread or command catalog unavailable");
        }
      return true;
    },
  };
}
