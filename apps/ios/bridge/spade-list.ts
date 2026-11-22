import type { ClientCore } from "@ace/client";
import {
  parseSpadeAgents,
  parseSpadeGroups,
  type SpadeAgent,
  type SpadeGroup,
} from "@ace/ui-core/spade-chat";
import type { SpadeListReach, SpadeReach } from "./spade-rows.ts";
import { spadeText } from "./spade-text.ts";

/*
 * A machine's Spade bots and groups as the phone last read them, read again on a pace that
 * follows what shows and whether any works. Each list is confirmed per connection: until it has
 * been read on this one, its rows read as unconfirmed, never working or done (#2567).
 */

/**
 * The bots are read again this often: faster while any works, as the web reads them. With the
 * Spade tab and every conversation away they are still read, slower, so the tab's face knows
 * whether any bot works (its eyes move only then).
 */
const listEvery = {
  shown: { working: 2_000, idle: 10_000 },
  away: { working: 10_000, idle: 30_000 },
};

/** What the list reads from the runtime around it. */
export interface SpadeListHost {
  owner: ClientCore;
  id(): string;
  later(delay: number, callback: () => void): () => void;
  /** Spade shows and runs, the connection is ready and the app is active: worth reading. */
  listable(): boolean;
  /** Spade runs, for the rows' reach. */
  ready(): boolean;
  /** The tab or a conversation shows: the faster pace. */
  shown(): boolean;
  /** A read is starting: what else is due with it. */
  reading(): void;
  /** The bots were read: who shares them follows. */
  listed(agents: SpadeAgent[]): void;
  /** Either list changed. */
  changed(): void;
  /** A read of both finished. */
  settled(): void;
}

export class SpadeList {
  private bots: SpadeAgent[] | undefined;
  /** The machine's groups; undefined until first read, and the last kept while a read fails. */
  private clubs: SpadeGroup[] | undefined;
  /** Writes to a bot this runtime made (`saved`): a list read begun before one is out of date. */
  private writes = 0;
  private listFailed = false;
  /**
   * The bots were read on this connection. Until then (after a reconnect) the last list may be
   * out of date: its rows read as unconfirmed, never working or done.
   */
  private botsConfirmed = false;
  /** The groups were read on this connection, as `botsConfirmed` is for the bots. */
  private groupsConfirmed = false;
  /** Moves on every dropped connection, so a read begun on an older one confirms nothing. */
  private epoch = 0;
  /** Why the bots couldn't be read on this connection, while they still haven't been. */
  private unconfirmedWhy: string | undefined;
  private groupsUnconfirmedWhy: string | undefined;
  private timer: (() => void) | undefined;
  private busy = false;
  private readonly host: SpadeListHost;

  constructor(host: SpadeListHost) {
    this.host = host;
  }

  /** The bots as last read; undefined until first read. */
  get agents(): SpadeAgent[] | undefined {
    return this.bots;
  }

  get groups(): SpadeGroup[] | undefined {
    return this.clubs;
  }

  /** The bots were read on this connection. */
  get confirmed(): boolean {
    return this.botsConfirmed;
  }

  /** The bots couldn't be read and none are known: the list says so, with Try again. */
  get failed(): boolean {
    return this.bots === undefined && this.listFailed;
  }

  /** The connection dropped: nothing read before it is confirmed, and the timer ends. */
  dropped(): void {
    this.stop();
    this.botsConfirmed = false;
    this.groupsConfirmed = false;
    this.unconfirmedWhy = undefined;
    this.groupsUnconfirmedWhy = undefined;
    this.epoch++;
  }

  stop(): void {
    this.timer?.();
    this.timer = undefined;
  }

  /**
   * Read the bots now, then again on their interval while Spade runs: quickly while the tab or a
   * conversation shows (a conversation's bubbles name its bot from the list), slower otherwise.
   */
  read(): void {
    this.stop();
    if (!this.host.listable() || this.busy) return;
    this.busy = true;
    this.host.reading();
    // A write since this read began (`saved`) is newer than what it brings back about the bots.
    const writes = this.writes;
    const epoch = this.epoch;
    const failed = (why: string) => {
      if (epoch === this.epoch && !this.botsConfirmed) this.unconfirmedWhy = why;
    };
    const read = (path: string) => spadeText(this.host.owner, this.host.id, "GET", path);
    // Bots and groups are two reads, and each shows as it lands: one failing never hides the
    // other. A Spade before groups answers no list, and the list holds bots only.
    const agents = read("/v1/agents").then(
      (body) => {
        const listed = parseSpadeAgents(body);
        if (listed && writes === this.writes) {
          this.bots = listed;
          if (epoch === this.epoch) this.botsConfirmed = true;
        }
        if (listed) this.host.listed(listed);
        else failed("Spade's answer didn't make sense.");
        this.listFailed = !listed;
        this.host.changed();
      },
      // The last list stays while a read fails; it reads again on its own.
      (error: unknown) => {
        failed(reason(error));
        this.listFailed = true;
        this.host.changed();
      },
    );
    const groups = read("/v1/groups").then(
      (body) => {
        const listed = parseSpadeGroups(body);
        if (!listed) return;
        this.clubs = listed;
        if (epoch === this.epoch) this.groupsConfirmed = true;
        this.host.changed();
      },
      (error: unknown) => {
        if (epoch === this.epoch && !this.groupsConfirmed)
          this.groupsUnconfirmedWhy = reason(error);
      },
    );
    void Promise.all([agents, groups]).finally(() => {
      this.busy = false;
      this.host.settled();
      // Written to while out: read again now, so the list confirms the write.
      if (writes !== this.writes) this.read();
      else this.schedule();
    });
  }

  /** The next read of the bots, at the pace for what shows and whether any works. */
  schedule(): void {
    this.stop();
    if (!this.host.listable() || this.busy) return;
    const pace = this.host.shown() ? listEvery.shown : listEvery.away;
    const working =
      (this.bots?.some((agent) => agent.state !== "idle") ?? false) ||
      (this.clubs?.some((group) => group.state !== "idle") ?? false);
    this.timer = this.host.later(working ? pace.working : pace.idle, () => this.read());
  }

  /** Whether the machine and its Spade answer now, and its lists were read since, for its rows. */
  get reach(): SpadeListReach {
    const of = (confirmed: boolean, why: string | undefined): SpadeReach => {
      if (this.host.owner.connectionState().getSnapshot() !== "ready") return "away";
      if (!this.host.ready()) return "unavailable";
      if (confirmed) return "answering";
      return {
        unconfirmed: why === undefined ? "Checking for changes" : `Couldn't confirm: ${why}`,
      };
    };
    return {
      bots: of(this.botsConfirmed, this.unconfirmedWhy),
      groups: of(this.groupsConfirmed, this.groupsUnconfirmedWhy),
    };
  }

  /**
   * A bot's task as a save just left it. Only the task: the write's answer leaves out what the
   * list carries beside the bot (its computer, its work), which must not go blank. The list
   * shows it now, and a read already out is dropped and made again (`read`).
   */
  saved(id: string, task: string): boolean {
    if (!this.bots?.some((agent) => agent.id === id)) return false;
    this.bots = this.bots.map((agent) => (agent.id === id ? { ...agent, task } : agent));
    this.writes++;
    return true;
  }
}

/** Why a read failed, in Spade's words where it gave some. */
const reason = (error: unknown) =>
  error instanceof Error ? error.message : "Spade didn't answer.";
