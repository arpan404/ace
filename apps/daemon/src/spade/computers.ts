import { PublicToolError } from "@ace/mcp-server/errors";
import {
  SpadeBotId,
  type AgentId,
  type ThreadId,
  type BrowserState,
  type McpAttribution,
  type McpCapability,
  type SpadeComputer,
  type SpadeComputerDriver,
  type SpadeComputerHandback,
  type SpadeComputerTab,
} from "@ace/protocol";
import type { CallAct } from "@ace/mcp-server";
import { ComputerDrivers, type TakeoverStore } from "./computer-drivers.ts";
import {
  ReportChanges,
  browserReport,
  screenReport,
  type SurfaceKind,
  type SurfaceReport,
} from "./computer-reports.ts";
import type { SpadeHostThread } from "./host-thread.ts";

/** The capabilities whose tools act on a bot's own computer: browser, screen and simulators. */
const computerCapabilities = new Set<McpCapability>(["browser", "screen", "devices"]);

/** How long a take-over waits for the bot's calls in flight to stop before it is answered. */
const drainMs = 10_000;

/** A bot's calls in flight, and the signal that stops them when the person takes over. */
interface BotCalls {
  controller: AbortController;
  active: number;
  idle: (() => void)[];
}

const computerKey = "computer:";
const hostKeyOf = (bot: string) => `${computerKey}${bot}`;

/** The bot a hidden thread's `hostKey` names as its computer, if it is one. */
export function botOfHostKey(key: string | undefined): string | undefined {
  return key?.startsWith(computerKey) ? key.slice(computerKey.length) : undefined;
}

export interface BotThread {
  threadId: ThreadId;
  agentId: AgentId;
}

export interface SpadeComputersDeps {
  /** Spade's own host thread now, whose grant names bots; undefined while there is none. */
  host(): SpadeHostThread | undefined;
  /** The bot's hidden thread if it has one. */
  find(hostKey: string): BotThread | undefined;
  /** Makes the bot's hidden thread in Spade's project, beside the host thread. */
  create(host: SpadeHostThread, hostKey: string, bot: string): BotThread | undefined;
  /**
   * The thread's browser tabs now, in ace's browser and in the person's own Chrome (`backend:
   * "user"`); empty when neither opened.
   */
  tabs(threadId: ThreadId): readonly SpadeComputerTab[];
  /** Apps the thread's agent is using now, in the order it began. */
  apps(threadId: ThreadId): readonly string[];
  /** The tab the thread's browser is on, if any. */
  activeTab(threadId: ThreadId): string | undefined;
  /** The bot whose computer this thread is; undefined for any other thread. */
  botOf(threadId: string): string | undefined;
  /** Tells Spade one surface of a bot's computer changed. Never throws. */
  report(bot: string, kind: SurfaceKind, report: SurfaceReport): void;
  /** Where take-overs are kept, so a restart leaves the person driving. */
  takeovers: TakeoverStore;
  /** Runs `run` after `ms`; the returned function cancels it. */
  after(ms: number, run: () => void): () => void;
  now(): number;
}

/**
 * Spade's bots' computers (`spade.computer.*`): each bot acts in ace's browser and screen as a
 * hidden thread of its own, so it sees and drives only its own tabs and its use of apps is its
 * own. The bot comes from Spade's MCP client (`_meta` `ace/acting-for`) on Spade's own grant,
 * never from a tool's arguments; on any other caller the name is ignored. While the person
 * drives a bot's computer, its browser and screen tools are refused with `person_driving`.
 */
export class SpadeComputers {
  private readonly deps: SpadeComputersDeps;
  private readonly drivers: ComputerDrivers;
  /** When each bot's thread first had an app in use, while it still has one. */
  private readonly using = new Map<ThreadId, number>();
  private readonly changes = new ReportChanges();
  private readonly calls = new Map<string, BotCalls>();
  constructor(deps: SpadeComputersDeps) {
    this.deps = deps;
    this.drivers = new ComputerDrivers(deps.now, deps.takeovers);
  }

  /**
   * Whom one ace tool call runs as (the registry's `CallActor`): the named bot's thread for
   * browser, screen and simulator tools on Spade's grant, else the caller. Throws
   * `person_driving` while the person drives that bot. The call is stopped if the person takes
   * over while it runs.
   */
  actAs(
    capability: McpCapability | null,
    caller: McpAttribution,
    actingFor: string | undefined,
  ): CallAct | undefined {
    if (!actingFor || !capability || !computerCapabilities.has(capability)) return undefined;
    const host = this.deps.host();
    if (!host || caller.threadId !== host.threadId) return undefined;
    const bot = SpadeBotId.safeParse(actingFor);
    if (!bot.success) return undefined;
    if (this.drivers.driver(bot.data) === "person") throw new PublicToolError("person_driving");
    const thread = this.ensure(host, bot.data);
    if (!thread) throw new PublicToolError("thread_not_found");
    const calls = this.callsOf(bot.data);
    calls.active++;
    let settled = false;
    return {
      caller: { sessionId: caller.sessionId, threadId: thread.threadId, agentId: thread.agentId },
      signal: calls.controller.signal,
      settled: () => {
        if (settled) return;
        settled = true;
        if (--calls.active > 0) return;
        for (const idle of calls.idle.splice(0)) idle();
      },
    };
  }

  /** The bot's computer now, for `GET /v1/agents/{id}/computer`. */
  computer(bot: string): SpadeComputer {
    const thread = this.deps.find(hostKeyOf(bot));
    const tabs = thread ? this.deps.tabs(thread.threadId) : [];
    const apps = thread ? this.deps.apps(thread.threadId) : [];
    const since = thread && apps.length ? this.using.get(thread.threadId) : undefined;
    return {
      bot,
      driver: this.drivers.driver(bot),
      ...(thread ? { threadId: thread.threadId } : {}),
      browser: { tabs: tabs.slice(0, 64) },
      screen: { apps: apps.slice(0, 16), ...(since !== undefined ? { since } : {}) },
    };
  }

  /**
   * Hands the bot's computer to `driver`. Taking over refuses the bot's next calls, stops the
   * ones in flight and answers once they have ended (or after ten seconds), so nothing the bot
   * started lands after the person has the controls. Handing back reports what the person did.
   * Setting the driver it already has changes nothing and reports no hand-back.
   */
  async drive(
    bot: string,
    driver: SpadeComputerDriver,
  ): Promise<{ driver: SpadeComputerDriver; handback?: SpadeComputerHandback }> {
    const thread = this.deps.find(hostKeyOf(bot));
    const tabs = thread ? this.deps.tabs(thread.threadId) : [];
    let result: { driver: SpadeComputerDriver; handback?: SpadeComputerHandback };
    if (driver === "person") {
      this.drivers.take(bot, tabs);
      await this.stop(bot);
      result = { driver };
    } else {
      const handback = this.drivers.handBack(bot, tabs);
      result = { driver, ...(handback ? { handback } : {}) };
    }
    if (thread) {
      this.sendBrowser(bot, thread.threadId, tabs, this.deps.activeTab(thread.threadId));
      this.send(
        bot,
        "screen",
        screenReport(thread.threadId, this.deps.apps(thread.threadId), this.driving(bot)),
      );
    }
    return result;
  }

  /**
   * A browser's state changed: a bot's browser is reported to Spade, and while the person drives
   * it, its tabs are noted for the hand-back.
   */
  browserChanged(state: Pick<BrowserState, "threadId" | "activeTabId">): void {
    const bot = this.deps.botOf(state.threadId);
    if (!bot) return;
    // Either backend changed; the bot's tabs are the ones in both.
    const threadId = state.threadId;
    const tabs = this.deps.tabs(threadId);
    this.drivers.observe(bot, tabs);
    this.sendBrowser(bot, threadId, tabs, state.activeTabId ?? this.deps.activeTab(threadId));
  }

  /** A screen session for `threadId` is watched or driven by the person. */
  screenUsedBy(threadId: string): void {
    const bot = this.deps.botOf(threadId);
    if (bot) this.drivers.usedScreen(bot);
  }

  /**
   * The threads using apps changed: keeps when each began, for `screen.since`, and reports each
   * bot whose screen use began, changed or ended.
   */
  appsChanged(threads: readonly { threadId: ThreadId; apps: readonly string[] }[]): void {
    const now = new Map(threads.map((entry) => [entry.threadId, entry.apps]));
    const touched = new Set([...now.keys(), ...this.using.keys()]);
    for (const threadId of now.keys())
      if (!this.using.has(threadId)) this.using.set(threadId, this.deps.now());
    for (const threadId of this.using.keys()) if (!now.has(threadId)) this.using.delete(threadId);
    for (const threadId of touched) {
      const bot = this.deps.botOf(threadId);
      if (bot)
        this.send(
          bot,
          "screen",
          screenReport(threadId, now.get(threadId) ?? [], this.driving(bot)),
        );
    }
  }

  private driving(bot: string): boolean {
    return this.drivers.driver(bot) === "person";
  }

  private sendBrowser(
    bot: string,
    threadId: string,
    tabs: readonly SpadeComputerTab[],
    activeTabId: string | undefined,
  ): void {
    this.send(bot, "browser", browserReport(threadId, tabs, activeTabId, this.driving(bot)));
  }

  private send(bot: string, kind: SurfaceKind, report: SurfaceReport): void {
    if (this.changes.changed(bot, kind, report)) this.deps.report(bot, kind, report);
  }

  private callsOf(bot: string): BotCalls {
    let calls = this.calls.get(bot);
    if (!calls) {
      calls = { controller: new AbortController(), active: 0, idle: [] };
      this.calls.set(bot, calls);
    } else if (calls.controller.signal.aborted) {
      // Handed back: later calls get a signal of their own; aborted ones still count down here.
      calls.controller = new AbortController();
    }
    return calls;
  }

  /** Stops the bot's calls in flight and waits for them to end, at most `drainMs`. */
  private stop(bot: string): Promise<void> {
    const calls = this.calls.get(bot);
    if (!calls) return Promise.resolve();
    calls.controller.abort();
    if (calls.active === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const cancel = this.deps.after(drainMs, done);
      function done() {
        cancel?.();
        resolve();
      }
      calls.idle.push(done);
    });
  }

  private ensure(host: SpadeHostThread, bot: string): BotThread | undefined {
    const key = hostKeyOf(bot);
    return this.deps.find(key) ?? this.deps.create(host, key, bot);
  }
}

export function tabOf(
  tab: { tabId: string; title: string; url: string },
  backend?: "user",
): SpadeComputerTab {
  return { tabId: tab.tabId, title: tab.title, url: tab.url, ...(backend ? { backend } : {}) };
}
