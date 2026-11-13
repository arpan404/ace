import type { SpadeComputerDriver, SpadeComputerHandback, SpadeComputerTab } from "@ace/protocol";

/** Addresses that say nothing about where the person went. */
const blank = (url: string) => url === "" || url === "about:blank";
const limit = 64;

interface Takeover {
  at: number;
  start: Map<string, SpadeComputerTab>;
  last: Map<string, SpadeComputerTab>;
  /** Every tab seen while driving, by id, so one opened and closed again still counts. */
  seen: Map<string, SpadeComputerTab>;
  visited: string[];
  screenUsed: boolean;
}

const byId = (tabs: readonly SpadeComputerTab[]) => new Map(tabs.map((tab) => [tab.tabId, tab]));

/**
 * Who drives each Spade bot's computer, and while the person does, what they did with it: the
 * addresses its tabs went to, the tabs opened and closed, and whether they used the screen. Pure:
 * the caller feeds it the bot's tabs and the clock.
 */
export class ComputerDrivers {
  private readonly now: () => number;
  private readonly takeovers = new Map<string, Takeover>();
  constructor(now: () => number) {
    this.now = now;
  }

  driver(bot: string): SpadeComputerDriver {
    return this.takeovers.has(bot) ? "person" : "bot";
  }

  /** Bots the person drives now. */
  driven(): string[] {
    return [...this.takeovers.keys()];
  }

  /** The person takes over with the bot's tabs as they are. False if they already drive. */
  take(bot: string, tabs: readonly SpadeComputerTab[]): boolean {
    if (this.takeovers.has(bot)) return false;
    const start = byId(tabs);
    this.takeovers.set(bot, {
      at: this.now(),
      start,
      last: new Map(start),
      seen: new Map(start),
      visited: [],
      screenUsed: false,
    });
    return true;
  }

  /** The bot's tabs changed while the person drives; ignored otherwise. */
  observe(bot: string, tabs: readonly SpadeComputerTab[]): void {
    const takeover = this.takeovers.get(bot);
    if (!takeover) return;
    for (const tab of tabs) {
      const before = takeover.last.get(tab.tabId) ?? takeover.start.get(tab.tabId);
      takeover.seen.set(tab.tabId, tab);
      if (blank(tab.url) || before?.url === tab.url) continue;
      if (!takeover.visited.includes(tab.url) && takeover.visited.length < limit)
        takeover.visited.push(tab.url);
    }
    takeover.last = byId(tabs);
  }

  /** The person used the bot's screen while driving. */
  usedScreen(bot: string): void {
    const takeover = this.takeovers.get(bot);
    if (takeover) takeover.screenUsed = true;
  }

  /** The person hands back; what they did, or undefined if the bot already drove. */
  handBack(bot: string, tabs: readonly SpadeComputerTab[]): SpadeComputerHandback | undefined {
    this.observe(bot, tabs);
    const takeover = this.takeovers.get(bot);
    if (!takeover) return undefined;
    this.takeovers.delete(bot);
    const end = byId(tabs);
    const opened = tabs.filter((tab) => !takeover.start.has(tab.tabId));
    // A tab opened and closed while driving was never the bot's: it is neither.
    const closed = [...takeover.start.values()]
      .filter((tab) => !end.has(tab.tabId))
      .map((tab) => takeover.seen.get(tab.tabId) ?? tab);
    return {
      drivenMs: Math.max(0, this.now() - takeover.at),
      visited: takeover.visited,
      opened: opened.slice(0, limit),
      closed: closed.slice(0, limit),
      screenUsed: takeover.screenUsed,
    };
  }
}
