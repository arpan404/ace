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
    clone?: {
      signal: AbortSignal;
      timeoutMs: number;
      made?: (directory: { dev: number; ino: number }) => void;
    },
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
    busy: (workspaceId) => {
      // Threads that run in the project's own checkout, not in a worktree of their own.
      const inCheckout = (threadId: ThreadId) => {
        const thread = store.readThread(threadId);
        return thread?.workspaceId === workspaceId && thread.details?.mode !== "worktree";
      };
      const unsettled = store
        .statement(
          "SELECT id FROM threads WHERE workspace_id=? AND archived_at IS NULL AND json_extract(status,'$.state') NOT IN ('done','new','failed') LIMIT 256",
        )
        .all(workspaceId)
        .map((row) => ThreadId.parse(row["id"]));
      if (unsettled.some(inCheckout)) return true;
      return (services.workspaceActions?.terminalThreads() ?? []).some(inCheckout);
    },
    parent: (requested) =>
      projects()
        .transferParent(requested)
        .catch(() => {
          throw new TransferError(
            "parent_not_allowed",
            "That folder isn't one this machine lets projects be made in.",
          );
        }),
    clone: async ({ key, parent, name, url, signal, made }) => {
      const result = await run(
        `${key}:clone`,
        { type: "workspace.clone", parent, name, url },
        {
          signal,
          timeoutMs: context.options.transfers?.cloneTimeoutMs ?? 180_000,
          made,
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
        stopRunning: true,
      });
    },
  };
}

/**
 * The continued thread there: same mode, provider and model when installed, no turn. Making it
 * and setting it up are separate steps, so a restart between them finishes the setup.
 */
export function targetThreads(context: ServiceContext): TargetThreadStarter {
  const { services, store, now } = context;
  return {
    async create(input) {
      const engine = services.engine;
      if (!engine) throw new TransferError("engine_unavailable", "Agents are starting here.");
      const threadId = ThreadId.parse(`transfer-${short(input.key)}`);
      const existing = store.getThread(threadId);
      // The same key is the same attempt, which already passed its cutoff.
      if (existing && existing.workspaceId === input.workspaceId) return threadId;
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
      let cut = false;
      const create = async (command: Command): Promise<CommandResult> => {
        const runtime = services.workspaceActions;
        const prepared =
          input.mode === "worktree" && runtime
            ? await runtime.prepareAgentCreation(command, new AbortController().signal)
            : undefined;
        try {
          if (prepared) await input.prepare?.(prepared.workspace.path);
          // From here the thread is the transfer's result; a cancel can no longer undo it.
          if (!cut) input.cutoff();
          cut = true;
          return await store.recordCommand(command.id, command.deviceId, () => {
            const result = engine.internalHandler.handle(command, {
              ...commandContext(store),
              ...(prepared ? { preparedWorkspace: prepared.workspace } : {}),
            });
            // The thread and the transfer's record of it commit together, before any await.
            if (result.ok) input.made(threadId);
            return result;
          });
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
      return threadId;
    },
    setUp(input, then) {
      const engine = services.engine;
      if (!engine) throw new TransferError("engine_unavailable", "Agents are starting here.");
      const from: ThreadContinuedOn = {
        hostId: HostId.parse(input.machine.hostId),
        name: input.machine.name.slice(0, 256),
        threadId: input.thread.sourceThreadId,
        at: now(),
      };
      // One transaction: the handoff, the link back and the caller's completion all land or none.
      store.atomic(() => {
        const thread = store.getThread(input.threadId);
        if (thread && !thread.details?.continuedFrom) {
          engine.adoptMachineHandoff(input.threadId, {
            handoff: input.thread.handoff,
            commandId: `transfer:${input.threadId}`,
            machine: input.machine.name,
            to: {
              provider: thread.provider,
              ...(thread.execution?.model ? { model: thread.execution.model } : {}),
            },
            at: now(),
          });
          store.appendEvents(input.threadId, [
            {
              type: "thread.client.updated",
              changes: {
                hasSentMessage: true,
                ...(thread.details ? { details: { ...thread.details, continuedFrom: from } } : {}),
              },
            },
          ]);
        }
        then();
      });
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
