import type { SpadeComputerDriver, SpadeComputerHandback, SpadeComputerTab } from "@ace/protocol";

/** Addresses that say nothing about where the person went. */
const blank = (url: string) => url === "" || url === "about:blank";
const limit = 64;

/** One take-over as it is kept, so a daemon restart leaves the person driving. */
export interface Takeover {
  at: number;
  start: SpadeComputerTab[];
  last: SpadeComputerTab[];
  /** Every tab seen while driving, so one the bot had and the person closed keeps its last look. */
  seen: SpadeComputerTab[];
  visited: string[];
  screenUsed: boolean;
}

/** Where take-overs are kept: the daemon's database, or memory in tests. */
export interface TakeoverStore {
  load(): Iterable<[bot: string, takeover: Takeover]>;
  save(bot: string, takeover: Takeover): void;
  remove(bot: string): void;
}

export function memoryTakeovers(): TakeoverStore {
  const rows = new Map<string, Takeover>();
  return {
    load: () => rows.entries(),
    save: (bot, takeover) => void rows.set(bot, structuredClone(takeover)),
    remove: (bot) => void rows.delete(bot),
  };
}

/** A tab across both backends: ace's browser and the person's own Chrome number tabs apart. */
const keyOf = (tab: SpadeComputerTab) => `${tab.backend ?? "ace"}:${tab.tabId}`;
const ids = (tabs: readonly SpadeComputerTab[]) => new Set(tabs.map(keyOf));

/**
 * Who drives each Spade bot's computer, and while the person does, what they did with it: the
 * addresses its tabs went to, the tabs opened and closed, and whether they used the screen. Every
 * change is saved, so a take-over outlives a daemon restart. Pure but for the store it is given.
 */
export class ComputerDrivers {
  private readonly now: () => number;
  private readonly store: TakeoverStore;
  private readonly takeovers = new Map<string, Takeover>();
  constructor(now: () => number, store: TakeoverStore) {
    this.now = now;
    this.store = store;
    for (const [bot, takeover] of store.load()) this.takeovers.set(bot, takeover);
  }

  driver(bot: string): SpadeComputerDriver {
    return this.takeovers.has(bot) ? "person" : "bot";
  }

  /** The person takes over with the bot's tabs as they are. False if they already drive. */
  take(bot: string, tabs: readonly SpadeComputerTab[]): boolean {
    if (this.takeovers.has(bot)) return false;
    this.set(bot, {
      at: this.now(),
      start: [...tabs],
      last: [...tabs],
      seen: [...tabs],
      visited: [],
      screenUsed: false,
    });
    return true;
  }

  /** The bot's tabs changed while the person drives; ignored otherwise. */
  observe(bot: string, tabs: readonly SpadeComputerTab[]): void {
    const takeover = this.takeovers.get(bot);
    if (!takeover) return;
    const before = new Map(
      [...takeover.start, ...takeover.last].map((tab) => [keyOf(tab), tab.url] as const),
    );
    const seen = new Map(takeover.seen.map((tab) => [keyOf(tab), tab]));
    const visited = [...takeover.visited];
    for (const tab of tabs) {
      seen.set(keyOf(tab), tab);
      if (blank(tab.url) || before.get(keyOf(tab)) === tab.url) continue;
      if (!visited.includes(tab.url) && visited.length < limit) visited.push(tab.url);
    }
    const next = { ...takeover, last: [...tabs], seen: [...seen.values()], visited };
    if (JSON.stringify(next) !== JSON.stringify(takeover)) this.set(bot, next);
  }

  /** The person used the bot's screen while driving. */
  usedScreen(bot: string): void {
    const takeover = this.takeovers.get(bot);
    if (takeover && !takeover.screenUsed) this.set(bot, { ...takeover, screenUsed: true });
  }

  /** The person hands back; what they did, or undefined if the bot already drove. */
  handBack(bot: string, tabs: readonly SpadeComputerTab[]): SpadeComputerHandback | undefined {
    this.observe(bot, tabs);
    const takeover = this.takeovers.get(bot);
    if (!takeover) return undefined;
    this.takeovers.delete(bot);
    this.store.remove(bot);
    const start = ids(takeover.start);
    const end = ids(tabs);
    const seen = new Map(takeover.seen.map((tab) => [keyOf(tab), tab]));
    // A tab opened and closed while driving was never the bot's: it is neither.
    const closed = takeover.start
      .filter((tab) => !end.has(keyOf(tab)))
      .map((tab) => seen.get(keyOf(tab)) ?? tab);
    return {
      drivenMs: Math.max(0, this.now() - takeover.at),
      visited: takeover.visited,
      opened: tabs.filter((tab) => !start.has(keyOf(tab))).slice(0, limit),
      closed: closed.slice(0, limit),
      screenUsed: takeover.screenUsed,
    };
  }

  private set(bot: string, takeover: Takeover): void {
    this.takeovers.set(bot, takeover);
    this.store.save(bot, takeover);
  }
}
