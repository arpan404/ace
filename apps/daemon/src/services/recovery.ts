import { automaticTarget, blockedUntil } from "@ace/accounts/availability";
import { canonicalContext, ProjectionCapabilities, encodedContextBudget } from "@ace/context";
import type { PrepareInput } from "../engine/input.ts";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import { AccountProvider } from "@ace/protocol/accounts";
import type { RecoveryPorts } from "../engine/recovery.ts";
import type { EngineRepository } from "../engine/repository.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
import { commandContext } from "../commands.ts";
import { browserTabContext, browserTabReader } from "../browser-tab-context.ts";
import { toolAttachment } from "../tool-result-content.ts";
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
      const keys = ["threads.followUpBehavior", "threads.limitPolicy"] as const;
      const scope = { ...(id ? { thread: id } : {}), ...(workspace ? { workspace } : {}) };
      let result;
      try {
        result = await services.settings?.read({ keys: [...keys], scope });
      } catch (error) {
        // Upgrade cleanup can remove a clean worktree while retaining its threads.
        // Read the remaining settings layers.
        if (!(workspace && error instanceof Error && "code" in error && error.code === "ENOENT"))
          throw error;
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
    moveTarget(id, requested) {
      const provider = AccountProvider.parse(store.getThread(id)?.provider);
      const current = metadata(id).instanceId;
      const to =
        requested ??
        automaticTarget(
          services.accountRegistry?.summaries(now()) ?? [],
          { id: current ?? "", provider },
          now(),
        )?.id;
      if (!to || to === current) throw new Error("No other available provider account");
      return to;
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
        "queue.resend",
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
  return async (command, provider, capabilities, continued) => {
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
    const contextService = context.services.context;
    if (!contextService || !("threadId" in p) || !p.threadId)
      throw new Error("Context requires an existing thread");
    const threadId = p.threadId;
    // Browser tabs the message mentions are read now, so the agent sees them as they are.
    const browser = context.services.browser;
    const tabs = browser
      ? await browserTabContext({
          threadId,
          context: p.context,
          reader: browserTabReader(browser, (id) => context.services.engine?.rootAgent(id)),
          store: async (bytes, name) =>
            toolAttachment(contextService, { threadId }, Buffer.from(bytes), {
              name,
              mimeType: "image/jpeg",
            }),
        })
      : undefined;
    const messageContext = tabs?.context ?? p.context;
    const message = tabs ? [...input, ...tabs.parts] : input;
    if (continued && p.context.attachments.length)
      await contextService.inheritAttachments(
        command.deviceId,
        continued.inheritFrom,
        threadId,
        p.context.attachments.map((attachment) => attachment.sha256),
      );
    const prepared = await contextService.compose(command.deviceId, threadId, messageContext, {
      provider:
        capabilities.attachmentInput?.format ??
        ProjectionCapabilities.shape.provider.catch("acp").parse(provider),
      images: capabilities.imageInput ? ["image/png", "image/jpeg", "image/gif", "image/webp"] : [],
      documents: capabilities.attachmentInput?.documents ?? [],
      embeddedContext: capabilities.attachmentInput?.embeddedContext ?? false,
      maxInlineBytes: capabilities.attachmentInput?.maxInlineBytes ?? 128 * 1024,
      ...(["acp", "opencode"].includes(capabilities.attachmentInput?.format ?? provider)
        ? { maxEncodedBytes: encodedContextBudget(message) }
        : {}),
    });
    try {
      return {
        input: [...message, ...canonicalContext(prepared.projection)],
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
