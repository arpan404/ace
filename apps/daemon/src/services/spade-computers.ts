import { AccessMode, ThreadId, type BrowserState, type SpadeComputerTab } from "@ace/protocol";
import { SpadeComputers, botOfHostKey, tabOf, type ActiveTab } from "../spade/computers.ts";
import { spadeRequest } from "../spade/forward.ts";
import type { BrowserService } from "@ace/browser";
import type { ComputerUsingThreads } from "../computer-using.ts";
import type { ScreenCowork } from "@ace/screen";
import type { ScreenManager } from "@ace/screen";
import type { TakeoverStore } from "../spade/computer-drivers.ts";
import type { SpadeHostThread } from "../spade/host-thread.ts";
import { storedTakeover } from "../stored-decode.ts";
import type { Store } from "../store.ts";
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
  const browsers = botBrowsers({
    ace: () => services.browser,
    user: () => services.userBrowserSessions,
  });
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
    tabs: (threadId) => browsers.tabs(threadId),
    apps: (threadId) =>
      services.computerUsing?.threads().find((entry) => entry.threadId === threadId)?.apps ?? [],
    activeTab: (threadId) => browsers.activeTab(threadId),
    screenPersonActive: (threadId) =>
      nativeScreenPersonActive(threadId, services.computerUsing, services.screenCowork) ||
      (services.screen
        ?.states()
        .some(
          (state) =>
            state.personActive === true &&
            (state.holder?.threadId === threadId || state.threadId === threadId),
        ) ??
        false),
    botOf(threadId) {
      const id = ThreadId.safeParse(threadId);
      const thread = id.success ? store.getThread(id.data) : undefined;
      return thread?.host === "spade" ? botOfHostKey(thread.hostKey) : undefined;
    },
    // Spade learns its bots' surfaces from these, for its live stream; a Spade that isn't
    // running misses them and reads `spade.computer.get` when it starts.
    report(bot, kind, report) {
      const connection = services.spade?.ready()?.connection;
      if (!connection) return;
      void spadeRequest(
        connection,
        {
          method: "PUT",
          path: `/v1/agents/${encodeURIComponent(bot)}/computer/surfaces/${kind}`,
          body: Buffer.from(JSON.stringify(report)),
          contentType: "application/json",
        },
        { signal: AbortSignal.timeout(5_000), maxBytes: 64 * 1024 },
      ).then(
        (answer) => {
          if (answer.kind !== "response" || answer.status >= 300)
            context.log.log("debug", "Spade didn't take a bot's computer surface", { bot, kind });
        },
        () => context.log.log("debug", "Spade didn't take a bot's computer surface", { bot, kind }),
      );
    },
    takeovers: storedTakeovers(store),
    after(ms, run) {
      const timer = setTimeout(run, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    now: context.now,
  });
  const stops = [
    browsers.watch((state, backend) => computers.browserChanged(state, backend)),
    services.computerUsing?.subscribe((threads) => computers.appsChanged(threads)),
    services.screen && watchScreenUse(services.screen, computers),
    services.computerUsing &&
      services.screenCowork &&
      watchNativeScreenUse(services.computerUsing, services.screenCowork, computers),
  ];
  context.resources.own(() => {
    for (const stop of stops) stop?.();
  }, "spade computers");
  return computers;
}

/** Take-overs in `spade_computer_drivers`, one row per bot the person drives. */
function storedTakeovers(store: Pick<Store, "statement">): TakeoverStore {
  return {
    *load() {
      const rows = store.statement("SELECT bot, takeover FROM spade_computer_drivers").all();
      for (const row of rows) yield [String(row.bot), storedTakeover(String(row.takeover))];
    },
    save(bot, takeover) {
      store
        .statement(
          `INSERT INTO spade_computer_drivers(bot, takeover) VALUES(?, ?)
          ON CONFLICT(bot) DO UPDATE SET takeover=excluded.takeover`,
        )
        .run(bot, JSON.stringify(takeover));
    },
    remove(bot) {
      store.statement("DELETE FROM spade_computer_drivers WHERE bot=?").run(bot);
    },
  };
}

type BrowserReads = Pick<
  BrowserService,
  "hasActiveSession" | "state" | "observeStates" | "savedTabs"
>;

/**
 * A bot's browser across both of ace's backends: ace's own browser and the person's own Chrome
 * (`backend: "user"`, ADR 0084), whose tabs are marked so the apps know where to watch them.
 */
export function botBrowsers(services: {
  ace: () => BrowserReads | undefined;
  user: () => BrowserReads | undefined;
}) {
  const backends = () => [
    { browser: services.ace(), backend: undefined },
    { browser: services.user(), backend: "user" as const },
  ];
  return {
    /**
     * The thread's tabs in both backends: a loaded browser's own, else the ones kept for it
     * since a restart (it restores them when it next opens). Undefined if those can't be read.
     */
    tabs(threadId: ThreadId): SpadeComputerTab[] | undefined {
      const tabs: SpadeComputerTab[] = [];
      for (const { browser, backend } of backends()) {
        if (!browser) continue;
        try {
          const each = browser.hasActiveSession(threadId)
            ? (browser.state(threadId).tabs ?? [])
            : browser.savedTabs(threadId);
          tabs.push(...each.map((tab) => tabOf(tab, backend)));
        } catch {
          return undefined;
        }
      }
      return tabs;
    },
    activeTab(threadId: ThreadId): ActiveTab | undefined {
      for (const { browser, backend } of backends())
        if (browser?.hasActiveSession(threadId)) {
          const tabId = browser.state(threadId).activeTabId;
          if (tabId) return { tabId, ...(backend ? { backend } : {}) };
        }
      return undefined;
    },
    /** Hears every state change in either backend, with the backend it came from. */
    watch(listener: (state: BrowserState, backend?: "user") => void): () => void {
      const stops = backends().map(({ browser, backend }) =>
        browser?.observeStates((state) => listener(state, backend)),
      );
      return () => {
        for (const stop of stops) stop?.();
      };
    },
  };
}

/**
 * Every screen session's state, for the bots' hand-backs: a session started or held for a bot's
 * thread, then driven by the person, counts as using that bot's screen.
 */
export function watchScreenUse(
  screen: Pick<ScreenManager, "watch">,
  computers: Pick<SpadeComputers, "screenChanged">,
): () => void {
  return screen.watch((state) => computers.screenChanged(state));
}

/** Native app actions have no legacy live-view session; their identities own cowork presence. */
export function nativeScreenPersonActive(
  threadId: ThreadId,
  using: Pick<ComputerUsingThreads, "appIds"> | undefined,
  cowork: Pick<ScreenCowork, "personActive"> | undefined,
): boolean {
  return cowork?.personActive(using?.appIds(threadId) ?? []) ?? false;
}

/** Native app lease changes reach Spade even when nobody opened a screen live view. */
export function watchNativeScreenUse(
  using: Pick<ComputerUsingThreads, "threads">,
  cowork: Pick<ScreenCowork, "subscribe">,
  computers: Pick<SpadeComputers, "appsChanged">,
): () => void {
  return cowork.subscribe(() => computers.appsChanged(using.threads()));
}
