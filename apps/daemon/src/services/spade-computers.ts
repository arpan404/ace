import { AccessMode, ThreadId } from "@ace/protocol";
import { SpadeComputers, tabOf } from "../spade/computers.ts";
import type { SpadeHostThread } from "../spade/host-thread.ts";
import type { ServiceContext } from "./types.ts";

/**
 * Spade's bots' computers, wired to the daemon: each bot's hidden thread lives in Spade's project
 * beside the host thread, with the host thread's provider and access. Its browser tabs and use of
 * apps are read from ace's browser and computer-use services; nothing here stores a frame.
 */
export function startSpadeComputers(
  context: ServiceContext,
  host: () => SpadeHostThread | undefined,
  folder: string,
): SpadeComputers {
  const { services, store } = context;
  const computers = new SpadeComputers({
    host,
    find(hostKey) {
      const row = store
        .statement(
          `SELECT id FROM threads WHERE json_extract(client,'$.host')='spade'
          AND json_extract(client,'$.hostKey')=? AND json_extract(client,'$.deletedAt') IS NULL
          ORDER BY created_at DESC, id LIMIT 1`,
        )
        .get(hostKey);
      if (!row) return undefined;
      const thread = store.getThread(ThreadId.parse(row.id));
      return thread?.rootAgentId ? { threadId: thread.id, agentId: thread.rootAgentId } : undefined;
    },
    create(spade, hostKey, bot) {
      const hosts = services.engine?.hosts;
      const thread = store.getThread(spade.threadId);
      if (!hosts || !thread) return undefined;
      const threadId = ThreadId.parse(context.id());
      const agentId = hosts.create({
        id: threadId,
        workspaceId: spade.workspaceId,
        title: `Spade bot ${bot}`,
        provider: thread.provider ?? "claude",
        access: AccessMode.safeParse(thread.permission?.effective).data ?? "read-only",
        cwd: folder,
        host: "spade",
        hostKey,
      });
      return agentId ? { threadId, agentId } : undefined;
    },
    tabs(threadId) {
      const browser = services.browser;
      if (!browser?.hasActiveSession(threadId)) return [];
      return (browser.state(threadId).tabs ?? []).map(tabOf);
    },
    apps: (threadId) =>
      services.computerUsing?.threads().find((entry) => entry.threadId === threadId)?.apps ?? [],
    now: context.now,
  });
  const stops = [
    services.browser?.observeStates((state) => computers.browserChanged(state)),
    services.computerUsing?.subscribe((threads) => computers.appsChanged(threads)),
    // A screen session the person drives for a bot's thread counts as using its screen.
    services.screen?.watch((state) => {
      if (state.controller === "human" && state.holder)
        computers.screenUsedBy(state.holder.threadId);
    }),
  ];
  context.resources.own(() => {
    for (const stop of stops) stop?.();
  }, "spade computers");
  return computers;
}
