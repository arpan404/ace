import { createHash } from "node:crypto";
import {
  Command,
  HostId,
  ProviderKind,
  ThreadId,
  WorkspaceId,
  type CommandResult,
  type ThreadContinuedOn,
} from "@ace/protocol";
import { commandContext } from "../commands.ts";
import type { ServiceContext } from "../services/types.ts";
import type { TargetProjects, TargetThreadStarter } from "./landing.ts";
import type { SourceThreads } from "./outgoing.ts";
import { TransferError } from "./ports.ts";

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** The target's projects through `Projects`, so a landed project registers as any other. */
export function targetProjects(context: ServiceContext): TargetProjects {
  const { services, store } = context;
  const projects = () => {
    if (!services.projects)
      throw new TransferError("projects_unavailable", "Projects aren't ready.");
    return services.projects;
  };
  const run = async (
    id: string,
    payload: unknown,
    clone?: { signal: AbortSignal; timeoutMs: number },
  ): Promise<CommandResult> => {
    const result = await projects().execute(
      Command.parse({ id, deviceId: "ace-transfer", payload }),
      () => !clone?.signal.aborted,
      clone,
    );
    if (!result.ok)
      throw new TransferError(
        result.error ?? "project_failed",
        `This machine couldn't add the project (${result.error ?? "failed"}).`,
      );
    return result;
  };
  return {
    list: () =>
      store
        .statement(
          "SELECT id,path FROM workspaces WHERE NOT EXISTS(SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY rowid DESC LIMIT 256",
        )
        .all()
        .map((row) => ({
          workspaceId: WorkspaceId.parse(row["id"]),
          path: String(row["path"]),
        })),
    parent: (requested) =>
      projects()
        .transferParent(requested)
        .catch(() => {
          throw new TransferError(
            "parent_not_allowed",
            "That folder isn't one this machine lets projects be made in.",
          );
        }),
    clone: async ({ key, parent, name, url, signal }) => {
      const result = await run(
        `${key}:clone`,
        { type: "workspace.clone", parent, name, url },
        {
          signal,
          timeoutMs: context.options.transfers?.cloneTimeoutMs ?? 180_000,
        },
      );
      if (!result.workspace) throw new TransferError("clone_failed", "The clone didn't register.");
      return result.workspace.id;
    },
    register: async ({ key, path, name }) => {
      const result = await run(`${key}:add`, { type: "workspace.add", path, name });
      if (!result.workspace)
        throw new TransferError("project_failed", "The project didn't register.");
      return result.workspace.id;
    },
    unregister: async (workspaceId) => {
      await run(`transfer-remove:${workspaceId}:${context.id()}`, {
        type: "workspace.remove",
        workspaceId,
        archiveThreads: true,
      });
    },
  };
}

/** The continued thread there: same mode, provider and model when installed, no turn. */
export function targetThreads(context: ServiceContext): TargetThreadStarter {
  const { services, store, now } = context;
  return {
    async start(input) {
      const engine = services.engine;
      if (!engine) throw new TransferError("engine_unavailable", "Agents are starting here.");
      const threadId = ThreadId.parse(`transfer-${short(input.key)}`);
      if (store.getThread(threadId)) return threadId;
      const wanted = input.thread.provider;
      const provider = engine.providerAvailability(wanted).installed
        ? wanted
        : ProviderKind.options.find((kind) => engine.providerAvailability(kind).installed);
      if (!provider)
        throw new TransferError("provider_unavailable", "No agent is installed on this machine.");
      const title = `${input.thread.title} (from ${input.machine.name})`.slice(0, 256);
      const prepare = (model: string | undefined) =>
        Command.parse({
          id: `transfer-thread:${short(input.key)}${model ? "" : ":default"}`,
          deviceId: input.deviceId,
          payload: {
            type: "thread.prepare",
            threadId,
            workspaceId: input.workspaceId,
            provider,
            ...(model ? { model } : {}),
            mode: input.mode,
            title,
            ...(input.mode === "worktree" && input.base ? { base: { ref: input.base } } : {}),
          },
        });
      const model = provider === wanted ? input.thread.model : undefined;
      const create = async (command: Command): Promise<CommandResult> => {
        const runtime = services.workspaceActions;
        const prepared =
          input.mode === "worktree" && runtime
            ? await runtime.prepareAgentCreation(command, new AbortController().signal)
            : undefined;
        try {
          if (prepared) await input.prepare?.(prepared.workspace.path);
          return store.recordCommand(command.id, command.deviceId, () =>
            engine.internalHandler.handle(command, {
              ...commandContext(store),
              ...(prepared ? { preparedWorkspace: prepared.workspace } : {}),
            }),
          );
        } finally {
          await prepared?.release();
        }
      };
      let result = await create(prepare(model));
      // A model this machine doesn't offer falls back to the provider's default.
      if (!result.ok && model && result.error === "model_unavailable")
        result = await create(prepare(undefined));
      if (!result.ok)
        throw new TransferError(
          result.error ?? "thread_failed",
          `This machine couldn't start the thread (${result.error ?? "failed"}).`,
        );
      engine.adoptMachineHandoff(threadId, {
        handoff: input.thread.handoff,
        commandId: `transfer:${short(input.key)}`,
        machine: input.machine.name,
        to: { provider, ...(model ? { model } : {}) },
        at: now(),
      });
      const from: ThreadContinuedOn = {
        hostId: HostId.parse(input.machine.hostId),
        name: input.machine.name.slice(0, 256),
        threadId: input.thread.sourceThreadId,
        at: now(),
      };
      store.atomic(() => {
        const thread = store.getThread(threadId);
        store.appendEvents(threadId, [
          {
            type: "thread.client.updated",
            changes: {
              hasSentMessage: true,
              ...(thread?.details ? { details: { ...thread.details, continuedFrom: from } } : {}),
            },
          },
        ]);
      });
      return threadId;
    },
  };
}

/** The source thread: thread.move's live checks, its handoff, and where the work went. */
export function sourceThreads({ services, store }: ServiceContext): SourceThreads {
  return {
    async assertIdle(threadId) {
      const refused = await services.workspaceActions?.continueRefusal(threadId);
      if (refused)
        throw new TransferError(
          refused,
          "The thread started working again before it was carried. Let it finish, then continue it again.",
        );
    },
    handoff(threadId) {
      const engine = services.engine;
      if (!engine) throw new TransferError("engine_unavailable", "Agents are starting here.");
      return engine.machineHandoff(threadId);
    },
    continuedOn(threadId, value) {
      store.atomic(() => {
        const thread = store.getThread(threadId);
        if (!thread?.details) return;
        store.appendEvents(threadId, [
          {
            type: "thread.client.updated",
            changes: { details: { ...thread.details, continuedOn: value } },
          },
        ]);
      });
    },
  };
}
