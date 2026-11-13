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
import { ComputerDrivers } from "./computer-drivers.ts";
import type { SpadeHostThread } from "./host-thread.ts";

/** The capabilities whose tools act on a bot's own computer. */
const computerCapabilities = new Set<McpCapability>(["browser", "screen"]);

const hostKeyOf = (bot: string) => `computer:${bot}`;

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
  /** The thread's browser tabs now; empty when its browser never opened. */
  tabs(threadId: ThreadId): readonly SpadeComputerTab[];
  /** Apps the thread's agent is using now, in the order it began. */
  apps(threadId: ThreadId): readonly string[];
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
  constructor(deps: SpadeComputersDeps) {
    this.deps = deps;
    this.drivers = new ComputerDrivers(deps.now);
  }

  /**
   * Whom one ace tool call runs as (the registry's `CallActor`): the named bot's thread for
   * browser and screen tools on Spade's grant, else the caller. Throws `person_driving` while
   * the person drives that bot.
   */
  actAs(
    capability: McpCapability | null,
    caller: McpAttribution,
    actingFor: string | undefined,
  ): McpAttribution | undefined {
    if (!actingFor || !capability || !computerCapabilities.has(capability)) return undefined;
    const host = this.deps.host();
    if (!host || caller.threadId !== host.threadId) return undefined;
    const bot = SpadeBotId.safeParse(actingFor);
    if (!bot.success) return undefined;
    if (this.drivers.driver(bot.data) === "person") throw new PublicToolError("person_driving");
    const thread = this.ensure(host, bot.data);
    if (!thread) throw new PublicToolError("thread_not_found");
    return { sessionId: caller.sessionId, threadId: thread.threadId, agentId: thread.agentId };
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
   * Hands the bot's computer to `driver`. Handing back reports what the person did; setting
   * the driver it already has reports nothing.
   */
  drive(
    bot: string,
    driver: SpadeComputerDriver,
  ): { driver: SpadeComputerDriver; handback?: SpadeComputerHandback } {
    const thread = this.deps.find(hostKeyOf(bot));
    const tabs = thread ? this.deps.tabs(thread.threadId) : [];
    if (driver === "person") {
      this.drivers.take(bot, tabs);
      return { driver };
    }
    const handback = this.drivers.handBack(bot, tabs);
    return { driver, ...(handback ? { handback } : {}) };
  }

  /** A browser's state changed: a driven bot's tabs are noted for its hand-back. */
  browserChanged(state: Pick<BrowserState, "threadId" | "tabs">): void {
    const bot = this.botOf(state.threadId);
    if (bot) this.drivers.observe(bot, (state.tabs ?? []).map(tabOf));
  }

  /** A screen session for `threadId` is watched or driven by the person. */
  screenUsedBy(threadId: string): void {
    const bot = this.botOf(threadId);
    if (bot) this.drivers.usedScreen(bot);
  }

  /** The threads using apps changed: keeps when each began, for `screen.since`. */
  appsChanged(threads: readonly { threadId: ThreadId }[]): void {
    const now = new Set(threads.map((entry) => entry.threadId));
    for (const threadId of now)
      if (!this.using.has(threadId)) this.using.set(threadId, this.deps.now());
    for (const threadId of this.using.keys()) if (!now.has(threadId)) this.using.delete(threadId);
  }

  /** The driven bot whose thread this is. */
  private botOf(threadId: string): string | undefined {
    for (const bot of this.drivers.driven())
      if (this.deps.find(hostKeyOf(bot))?.threadId === threadId) return bot;
    return undefined;
  }

  private ensure(host: SpadeHostThread, bot: string): BotThread | undefined {
    const key = hostKeyOf(bot);
    return this.deps.find(key) ?? this.deps.create(host, key, bot);
  }
}

export function tabOf(tab: { tabId: string; title: string; url: string }): SpadeComputerTab {
  return { tabId: tab.tabId, title: tab.title, url: tab.url };
}
