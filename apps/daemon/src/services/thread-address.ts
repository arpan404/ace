import { setTimeout as delay } from "node:timers/promises";
import { summarizeThreadReference } from "@ace/context";
import { logFields } from "@ace/diagnostics";
import { spadeRequest } from "@ace/service/spade";
import { AgentId, Command, type CommandResult, type DeviceId } from "@ace/protocol";
import { commandContext } from "../commands.ts";
import { ThreadAskStore, type AskRow } from "../thread-address/asks-store.ts";
import { askTaskPrefix, ThreadAsks } from "../thread-address/asks.ts";
import { askKey, firstState } from "../thread-address/plan.ts";
import type { SocketContext, SocketService } from "./socket.ts";
import type { ServiceContext } from "./types.ts";

/*
 * `thread.address` (ADR 0194): the person's message to Spade bots, clubs or other threads'
 * agents, posted in their thread instead of reaching its agent. Bots and clubs are asked through
 * `ThreadAsks`; an agent gets the message in its own thread as the person's, from this one.
 */

export function startThreadAddress(context: ServiceContext): void {
  const { store, services, resources, now } = context;
  const engine = services.engine;
  if (!engine) return;
  const asks = new ThreadAsks({
    store: new ThreadAskStore(store),
    spade: () => services.spade?.ready()?.connection,
    call: spadeRequest,
    post: (threadId, key, draft) => engine.posts.post(threadId, key, draft),
    hold: (threadId, task, hold) => {
      const agent = engine.rootAgent(threadId);
      if (agent) engine.externalHold(threadId, AgentId.parse(agent), task, hold);
    },
    summary: (threadId) => {
      const thread = store.getThread(threadId);
      if (!thread) return undefined;
      return summarizeThreadReference(
        { type: "thread_ref", threadId, budgetBytes: 4096 },
        thread,
        store.readBoundedItemPage(threadId, store.headSeq() + 1, 20, 32768),
      ).summary;
    },
    title: (threadId) => store.getThread(threadId)?.title ?? "",
    now,
    sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined),
    log: (message, error) =>
      context.log.log("warn", message, logFields([["error", String(error)]])),
  });
  services.threadAsks = asks;
  engine.bindExternalTaskStop(askTaskPrefix, (key) => void asks.stop(key));
  // Asks left open by the last run carry on; those waiting for Spade go once it is ready.
  asks.resume();
  const stopWatching = services.spade?.onReady(() => asks.resume());
  resources.own(() => {
    stopWatching?.();
    return asks.close();
  });
}

export function createThreadAddressSession({
  options,
  send,
  canReadThread,
}: SocketContext): SocketService {
  const refuse = (command: Command, error: string): CommandResult => ({
    commandId: command.id,
    ok: false,
    error,
  });
  return {
    command: {
      types: ["thread.address"],
      scope: () => "operate",
      async accept(command, device) {
        const p = command.payload;
        if (p.type !== "thread.address") return;
        const receipt = options.store.commandReceipt(command.id, device);
        if (receipt) {
          send({ type: "commandResult", ...receipt });
          return;
        }
        const asks = options.threadAsks;
        const engine = options.engine;
        const thread = options.store.getThread(p.threadId);
        const result = (() => {
          if (!asks || !engine) return refuse(command, "unsupported");
          if (!thread || thread.deletedAt !== undefined || !canReadThread(p.threadId))
            return refuse(command, "thread_not_found");
          if (!engine.rootAgent(p.threadId)) return refuse(command, "thread_not_started");
          const agents = p.to.flatMap((to) => (to.kind === "agent" ? [to.threadId] : []));
          if (agents.some((id) => id === p.threadId || !canReadThread(id)))
            return refuse(command, "forbidden");
          return options.store.recordCommand(command.id, device, () => {
            const at = (options.now ?? Date.now)();
            const rows: AskRow[] = p.to.map((to, index) => ({
              key: askKey(command.id, index),
              commandId: command.id,
              index,
              threadId: p.threadId,
              to,
              state: firstState,
              detail: undefined,
              posted: 0,
              delivered: false,
              createdAt: at,
              done: false,
            }));
            asks.record(
              { commandId: command.id, threadId: p.threadId, input: p.input, share: p.share },
              rows,
              at,
            );
            for (const row of rows)
              if (row.to.kind === "agent") asks.sendingTo(row.key);
              else asks.drive(row.key);
            return { commandId: command.id, ok: true, threadId: p.threadId };
          });
        })();
        send({ type: "commandResult", ...result });
        if (!result.ok || !asks || !thread) return;
        // Each agent gets the person's message in its own thread, from this one.
        for (const [index, to] of p.to.entries()) {
          if (to.kind !== "agent") continue;
          const target = options.store.getThread(to.threadId);
          const shared = p.share === "thread" && target?.workspaceId === thread.workspaceId;
          const sent = Command.parse({
            id: `${command.id}.to.${index}`,
            deviceId: device,
            payload: {
              type: "thread.send",
              threadId: to.threadId,
              input: p.input,
              delivery: "steer",
              origin: { kind: "person", via: { threadId: thread.id, title: thread.title } },
              ...(shared
                ? {
                    context: {
                      items: [{ type: "thread_ref", threadId: thread.id, budgetBytes: 4096 }],
                      mentions: [],
                    },
                  }
                : {}),
            },
          });
          const outcome = await deliverToAgent(options, sent, device);
          asks.settleAgent(askKey(command.id, index), outcome);
        }
      },
    },
  };
}

/** Sends the derived `thread.send` as the person's own, once by its id. */
async function deliverToAgent(
  options: SocketContext["options"],
  command: Command,
  device: DeviceId,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await options.engine?.prepareCommand(command);
    const result = options.store.recordCommand(command.id, device, () =>
      options.handler.handle(command, commandContext(options.store)),
    );
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "not_sent" };
  } catch (error) {
    options.log?.(error);
    return { ok: false, error: "not_sent" };
  }
}
