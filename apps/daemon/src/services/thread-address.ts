import { setTimeout as delay } from "node:timers/promises";
import { logFields } from "@ace/diagnostics";
import { createTextRedactor } from "@ace/redaction";
import { spadeRequest } from "@ace/service/spade";
import { sharesWords } from "@ace/ui-core/mention-shares";
import { AgentId, Command, type CommandResult, type DeviceId, type Thread } from "@ace/protocol";
import { commandContext } from "../commands.ts";
import { readLocalToken } from "../local-token.ts";
import { inboxProof } from "../machines/target-spade.ts";
import type { Store } from "../store.ts";
import { ThreadAskStore, type AskRow } from "../thread-address/asks-store.ts";
import { askTaskPrefix, ThreadAsks } from "../thread-address/asks.ts";
import { contextPack } from "../thread-address/context-pack.ts";
import { askKey, firstState } from "../thread-address/plan.ts";
import type { SocketContext, SocketService } from "./socket.ts";
import type { ServiceContext } from "./types.ts";

/*
 * `thread.address` (ADR 0194): beside the person's `thread.send`, which their thread's agent gets
 * as always, the same words go to the Spade bots and clubs they mention, with the thread's
 * context pack, and to the other threads' agents they mention, as the person's own message from
 * this thread. A follow-up to a bot's reply goes to the bots alone.
 */

export function startThreadAddress(context: ServiceContext): void {
  const { store, services, resources, now } = context;
  const engine = services.engine;
  if (!engine) return;
  const asks = new ThreadAsks({
    store: new ThreadAskStore(store),
    spade: () => services.spade?.ready()?.connection,
    call: spadeRequest,
    sign: (body) => {
      let key: string;
      try {
        key = readLocalToken(context.config.dataDir);
      } catch {
        return undefined;
      }
      const time = now();
      return {
        "x-ace-from-host": threadAskSender,
        "x-ace-from-name": "ace",
        "x-ace-inbox-time": String(time),
        "x-ace-inbox-proof": inboxProof(key, time, threadAskSender, "ace", body),
      };
    },
    post: (threadId, key, draft) => engine.posts.post(threadId, key, draft),
    hold: (threadId, task, hold) => {
      const agent = engine.rootAgent(threadId);
      if (agent) engine.externalHold(threadId, AgentId.parse(agent), task, hold);
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

/** Who thread asks come from, as Spade checks: no paired machine's device id looks like it. */
const threadAskSender = "ace:thread";

/** What of the thread the pack names: its project (none for a chat), branch and pull request. */
function packThread(thread: Thread) {
  const details = thread.details;
  const chat = details?.workspace?.kind === "chat";
  return {
    title: thread.title,
    project: chat ? undefined : details?.workspace?.name,
    branch: details?.branch ?? undefined,
    pullRequest: details?.linkedPr?.number,
  };
}

/** The context pack as it is now, and its words; only the message when the person chose that. */
function packFor(store: Store, thread: Thread, share: "thread" | "message", files: string[]) {
  const facts = packThread(thread);
  if (share === "message")
    return { pack: undefined, shares: sharesWords({ ...facts, files: 0 }, "message") };
  const page = store.readBoundedItemPage(thread.id, store.headSeq() + 1, 40, 64 * 1024);
  return contextPack(facts, files, page.items, createTextRedactor({}));
}

const refuse = (command: Command, error: string): CommandResult => ({
  commandId: command.id,
  ok: false,
  error,
});

export function createThreadAddressSession({
  options,
  send,
  canReadThread,
}: SocketContext): SocketService {
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
          if (!p.to.length && !p.devices.length) return refuse(command, "invalid_command");
          // A follow-up answers a bot's reply: it goes to bots and clubs only.
          if (p.followUp && p.to.some((to) => to.kind === "agent"))
            return refuse(command, "invalid_command");
          const agents = p.to.flatMap((to) => (to.kind === "agent" ? [to.threadId] : []));
          if (agents.some((id) => id === p.threadId || !canReadThread(id)))
            return refuse(command, "forbidden");
          const { pack, shares } = packFor(options.store, thread, p.share, p.files);
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
              {
                commandId: command.id,
                threadId: p.threadId,
                about: p.about,
                input: p.input,
                share: p.share,
                shares,
                pack,
                followUp: p.followUp === true,
                devices: p.devices,
              },
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
        // Each agent gets the person's message in its own thread, from this one: a steer that
        // joins its running turn or starts the next, labelled as sent from here.
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
