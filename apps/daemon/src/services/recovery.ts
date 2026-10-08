import { automaticTarget, blockedUntil } from "@ace/accounts/availability";
import { canonicalContext, ProjectionCapabilities } from "@ace/context";
import type { PrepareInput } from "../engine/input.ts";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import { AccountProvider } from "@ace/protocol/accounts";
import type { RecoveryPorts } from "../engine/recovery.ts";
import type { EngineRepository } from "../engine/repository.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
import { commandContext } from "../commands.ts";
/** Trusted integration ports reuse settings, quota and migration owners. */
export function recoveryPorts(
  context: Pick<ServiceContext, "services" | "store" | "now">,
  metadata: (id: ThreadId) => ReturnType<EngineRepository["session"]>,
): RecoveryPorts {
  const { services, store, now } = context;
  return {
    async preferences(id) {
      const thread = id ? store.getThread(id) : undefined;
      const workspace = thread ? store.getWorkspacePath(thread.workspaceId) : undefined;
      const keys = [
        "threads.followUpBehavior",
        "threads.continueAfterRestart",
        "threads.limitPolicy",
      ] as const;
      const scope = { ...(id ? { thread: id } : {}), ...(workspace ? { workspace } : {}) };
      let missingWorkspace = false;
      let result;
      try {
        result = await services.settings?.read({ keys: [...keys], scope });
      } catch (error) {
        // Upgrade cleanup can remove a clean worktree while retaining its threads.
        // Read the remaining settings layers, but never resume into a missing checkout.
        if (!(workspace && error instanceof Error && "code" in error && error.code === "ENOENT"))
          throw error;
        missingWorkspace = true;
        result = await services.settings?.read({
          keys: [...keys],
          scope: id ? { thread: id } : {},
        });
      }
      const values = Object.fromEntries(
        result?.entries.map((entry) => [entry.key, entry.value]) ?? [],
      );
      return {
        followUpBehavior: z
          .enum(["steer", "queue"])
          .parse(values["threads.followUpBehavior"] ?? "queue"),
        continueAfterRestart:
          !missingWorkspace && z.boolean().parse(values["threads.continueAfterRestart"] ?? false),
        limitPolicy: z
          .enum(["manual", "resume_at_reset", "snooze_until_reset", "migrate_now"])
          .parse(values["threads.limitPolicy"] ?? "manual"),
      };
    },
    resetAt(id) {
      const instance = metadata(id).instanceId;
      const quota = instance ? services.accountRegistry?.get(instance)?.quota : undefined;
      // The daemon's own blocking-window rule, shared with the clients that word it.
      return quota ? blockedUntil(quota, now()) : undefined;
    },
    async migrate(id, target) {
      const session = metadata(id);
      if (session.backend === "cursor-sdk")
        throw new Error(
          "Cursor SDK checkpoints cannot migrate accounts; create a portable context handoff instead",
        );
      const provider = AccountProvider.parse(store.getThread(id)?.provider);
      if (!services.accounts || !session.instanceId || !session.nativeSessionId)
        throw new Error("Account-bound native session is required");
      const to =
        target ??
        automaticTarget(
          services.accountRegistry?.summaries(now()) ?? [],
          { id: session.instanceId, provider },
          now(),
        )?.id;
      if (!to || to === session.instanceId) throw new Error("No other available provider account");
      const result = await services.accounts.handle({
        type: "accounts.migrate",
        requestId: `recovery:${id}`,
        provider,
        nativeSessionId: session.nativeSessionId,
        from: session.instanceId,
        to,
      });
      if (result.type !== "accounts.migrate" || result.result.status !== "migrated")
        throw new Error(
          result.type === "accounts.migrate"
            ? result.result.status === "migrated"
              ? "Unexpected migration result"
              : result.result.reason
            : "Unexpected migration result",
        );
      return { nativeSessionId: result.result.nativeSessionId, instanceId: to };
    },
    contextWindow(provider, instance, model) {
      const resolved = services.models?.resolve({
        provider,
        ...(instance ? { instance } : {}),
        role: "context-meter",
        model,
      });
      return resolved?.ok ? resolved.model.contextWindow : undefined;
    },
  };
}
export function createRecoverySession(context: SocketContext): SocketService {
  const { options, send, authorize, canReadThread, fail } = context;
  return {
    command: {
      types: [
        "queue.edit",
        "queue.move",
        "queue.remove",
        "queue.pause",
        "queue.resume",
        "thread.resume",
        "thread.limit",
      ],
      scope: () => "operate",
      async accept(command, device) {
        if (
          "threadId" in command.payload &&
          command.payload.threadId &&
          !canReadThread(ThreadId.parse(command.payload.threadId))
        ) {
          send({ type: "commandResult", commandId: command.id, ok: false, error: "forbidden" });
          return;
        }
        await options.engine?.prepareCommand(command);
        if (!context.connected() || !authorize("operate")) return;
        if (
          "threadId" in command.payload &&
          command.payload.threadId &&
          !canReadThread(ThreadId.parse(command.payload.threadId))
        ) {
          send({ type: "commandResult", commandId: command.id, ok: false, error: "forbidden" });
          return;
        }
        send({
          type: "commandResult",
          ...options.store.recordCommand(command.id, device, () =>
            options.handler.handle(command, commandContext(options.store)),
          ),
        });
      },
    },
    handle(message) {
      if (message.type !== "queue.get") return false;
      if (!authorize("read") || !canReadThread(message.threadId))
        fail("forbidden", "Read scope required", false, { requestId: message.requestId });
      else if (!options.engine || !options.store.getThread(message.threadId))
        fail("thread_not_found", "Engine thread unavailable", false, {
          requestId: message.requestId,
        });
      else {
        try {
          send({
            type: "queue.result",
            requestId: message.requestId,
            queue: options.engine.queuePage(message),
          });
        } catch (error) {
          fail(
            "queue_conflict",
            error instanceof Error ? error.message : "Queue read failed",
            false,
            { requestId: message.requestId },
          );
        }
      }
      return true;
    },
  };
}

export function prepareQueuedInput(context: Pick<ServiceContext, "services">): PrepareInput {
  return async (command, provider, capabilities) => {
    const p = command.payload;
    if (p.type !== "thread.send" && p.type !== "thread.create")
      throw new Error("Expected a message");
    const input = p.input.some((part) => part.type === "mention")
      ? await (() => {
          if (!context.services.commands?.prepareMentions || !("threadId" in p) || !p.threadId)
            throw new Error("Catalog mention preparation unavailable");
          return context.services.commands.prepareMentions(p.threadId, p.input);
        })()
      : p.input;
    if (!p.context) return { input, release() {} };
    if (!context.services.context || !("threadId" in p) || !p.threadId)
      throw new Error("Context requires an existing thread");
    const prepared = await context.services.context.compose(
      command.deviceId,
      p.threadId,
      p.context,
      {
        provider:
          capabilities.attachmentInput?.format ??
          ProjectionCapabilities.shape.provider.catch("acp").parse(provider),
        images: capabilities.imageInput
          ? ["image/png", "image/jpeg", "image/gif", "image/webp"]
          : [],
        documents: capabilities.attachmentInput?.documents ?? [],
        embeddedContext: capabilities.attachmentInput?.embeddedContext ?? false,
        maxInlineBytes: capabilities.attachmentInput?.maxInlineBytes ?? 128 * 1024,
      },
    );
    try {
      return {
        input: [...input, ...canonicalContext(prepared.projection)],
        attachments: prepared.attachments,
        attachmentPaths: prepared.attachmentPaths,
        diagnostics: prepared.diagnostics,
        release: prepared.release,
      };
    } catch (error) {
      prepared.release();
      throw error;
    }
  };
}
