import { onSocketMove, type ClientCore } from "@ace/client";
import { spadeExchange } from "@ace/client/spade-http";
import { SpadeDaemonLive } from "@ace/client/spade-live";
import type { SpadeMethod, SpadeStatus } from "@ace/protocol";
import {
  parseSpadeAgents,
  parseSpadeGroups,
  SpadeConversationFollow,
  SpadeGroupFollow,
  spadeProblemNeeds,
  spadeRefusal,
  SpadeRequestError,
  type SpadeAgent,
  type SpadeFollowLink,
  type SpadeGroup,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { botFace, spadeGroupHead, spadeGroupRows } from "./spade-group-rows.ts";
import {
  spadeConversationHead,
  spadeConversationRows,
  spadeListRows,
  spadePlaceLine,
} from "./spade-rows.ts";

/*
 * Spade on the iPhone (ADR 0121): always through the daemon's `spade.*` family, since the phone
 * never reaches Spade directly. It follows whether the machine shows Spade at all (Settings ›
 * Beta, ADR 0139) for the tab bar; while the Spade tab shows, its bots; and the one conversation
 * open, live. Swift draws the rows this puts. Requests with an outcome are `spade-requests.ts`.
 */

export interface SpadeDeps {
  now(): number;
  id(): string;
  later(delay: number, callback: () => void): () => void;
}

export const NativeSpadeAction = z.discriminatedUnion("type", [
  /** The Spade tab is on screen (or no longer is): its bots are read while it shows. */
  z.object({ type: z.literal("spade.watch"), on: z.boolean() }),
  /** Follow this conversation live, or none; a group's (ADR 0132) names its group. */
  z.object({
    type: z.literal("spade.open"),
    conversationId: z.string().min(1).max(256).nullable(),
    group: z.string().min(1).max(256).optional(),
  }),
  /** Try following the open conversation again after a problem. */
  z.object({ type: z.literal("spade.retry") }),
  /** The app's scene is active (or no longer is): the bots are read only while it is. */
  z.object({ type: z.literal("spade.active"), active: z.boolean() }),
  /** Pull to refresh: read Spade's state, the setting and the bots again now. */
  z.object({ type: z.literal("spade.refresh") }),
]);
export type NativeSpadeAction = z.infer<typeof NativeSpadeAction>;

/**
 * The bots are read again this often: faster while any works, as the web reads them. With the
 * Spade tab and every conversation away they are still read, slower, so the tab's face knows
 * whether any bot works (its eyes move only then).
 */
const listEvery = {
  shown: { working: 2_000, idle: 10_000 },
  away: { working: 10_000, idle: 30_000 },
};

const Setting = z.object({ entries: z.array(z.object({ value: z.unknown() })).optional() });

/** A path segment from an id Spade gave us. */
export const segment = (id: string) => encodeURIComponent(id);

/** One request to Spade through the daemon: its text on 2xx, else a `SpadeRequestError`. */
export async function spadeText(
  owner: ClientCore,
  id: () => string,
  method: SpadeMethod,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const answer = await spadeExchange(
    owner,
    { method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { id, signal },
  );
  if (answer.kind === "error") throw new SpadeRequestError(answer.message, undefined, answer.code);
  const text = answer.encoding === "text" ? answer.body : "";
  if (answer.status < 200 || answer.status > 299)
    throw new SpadeRequestError(
      spadeRefusal(answer.status, text),
      answer.status,
      undefined,
      spadeProblemNeeds(text),
    );
  return text;
}

/** The conversation open on the phone: a bot's, or a group's. */
type Open = { id: string; stop: () => void } & (
  | { kind: "bot"; follow: SpadeConversationFollow }
  | { kind: "group"; group: string; follow: SpadeGroupFollow }
);

export class NativeSpade {
  private status: SpadeStatus | undefined;
  private enabled: boolean | undefined;
  private agents: SpadeAgent[] | undefined;
  /** The machine's groups; undefined until first read, and the last kept while a read fails. */
  private groups: SpadeGroup[] | undefined;
  /** Writes to a bot this runtime made (`saved`): a list read begun before one is out of date. */
  private writes = 0;
  private listFailed = false;
  private watching = false;
  /** This runtime went away: nothing reads again. */
  private stopped = false;
  /** The app's scene is active: in the background or behind the lock screen nothing reads. */
  private active = true;
  private stops: (() => void)[] = [];
  private listTimer: (() => void) | undefined;
  private listReading = false;
  private asked = 0;
  private open: Open | undefined;
  /** What Swift holds of the open conversation: each row as last put, and their order. */
  private sent = new Map<string, string>();
  private order: readonly string[] = [];
  /** The seen mark last sent, `conversation:seq`, so each latest message is marked once. */
  private seen: string | undefined;
  private readonly live: SpadeDaemonLive;
  private readonly owner: ClientCore;
  private readonly sink: PatchSink;
  private readonly deps: SpadeDeps;
  /** The machine's name, for a row whose Spade doesn't answer ("Off on Studio"). */
  private machine: string | undefined;
  /** The machine's host id, so group members match local roster bots by machine and bot id. */
  private hostId: string | undefined;

  constructor(owner: ClientCore, sink: PatchSink, deps: SpadeDeps) {
    this.owner = owner;
    this.sink = sink;
    this.deps = deps;
    this.live = new SpadeDaemonLive(owner, deps.id);
  }

  get ready(): boolean {
    return this.status?.state === "ready";
  }

  /**
   * Follow Spade's status for as long as this runtime lives: whether the machine shows Spade
   * decides the tab bar. The daemon's status watch ends with the socket, so a new one asks again.
   */
  start(): void {
    const connection = this.owner.connectionState();
    try {
      this.stops.push(
        this.owner.onMessage((message) => {
          if (message.type === "spade.status.changed") this.setStatus(message.status);
        }),
      );
    } catch {
      // At the listener limit the status refreshes only on reconnect.
    }
    this.stops.push(
      connection.subscribe(() => {
        // A dropped connection ends the list's timer; it reads again once ready.
        if (connection.getSnapshot() === "ready") this.refresh();
        else this.stopList();
      }),
      onSocketMove(this.owner, () => this.refresh()),
    );
    this.refresh();
  }

  /** The open conversation's follow, for sends that should show at once. */
  follow(conversationId: string): SpadeConversationFollow | undefined {
    const open = this.open;
    return open?.kind === "bot" && open.id === conversationId ? open.follow : undefined;
  }

  /** The open group's follow, for posts that should show at once. */
  groupFollow(conversationId: string): SpadeGroupFollow | undefined {
    const open = this.open;
    return open?.kind === "group" && open.id === conversationId ? open.follow : undefined;
  }

  handle(action: NativeSpadeAction): void {
    switch (action.type) {
      case "spade.watch":
        this.watching = action.on;
        // Shown, the list is read at once; put away, it goes on at the slower pace.
        return action.on ? this.readList() : this.scheduleList();
      case "spade.open":
        return this.openConversation(action.conversationId, action.group);
      case "spade.retry":
        return this.open?.follow.retry();
      case "spade.active":
        if (action.active === this.active) return;
        this.active = action.active;
        return action.active ? this.readList() : this.stopList();
      case "spade.refresh":
        return this.refresh();
    }
  }

  /** This runtime is going away: every watch, poll and stream ends. */
  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.stopped = true;
    this.watching = false;
    this.stopList();
    this.openConversation(null);
  }

  /** Spade's state, the setting and the bots are out of date: read them again now. */
  refresh(): void {
    this.ask();
    void this.readName();
    void this.readEnabled();
    this.readList();
  }

  private ask() {
    if (this.owner.state !== "ready") return;
    const asked = ++this.asked;
    void this.owner.request({ type: "spade.status" }).then(
      (reply) => {
        if (asked === this.asked) this.setStatus(reply.status);
      },
      () => {},
    );
  }

  private setStatus(status: SpadeStatus) {
    const wasReady = this.ready;
    this.status = status;
    this.open?.follow.setReady(this.ready);
    // Turning Spade on or off changes the setting first; the status says it took.
    if (this.ready !== wasReady) {
      void this.readEnabled();
      this.readList();
    }
    this.put();
  }

  private async readName() {
    if (this.machine !== undefined || this.owner.state !== "ready") return;
    const reply = await this.owner.request({ type: "host.identity" }).catch(() => undefined);
    if (!reply) return;
    this.machine = reply.identity.displayName;
    this.hostId = reply.identity.hostId;
    this.put();
    this.publishOpen();
  }

  private async readEnabled() {
    if (this.owner.state !== "ready") return;
    const reply = await this.owner
      .request({ type: "settings.get", key: "spade.enabled", scope: {} }, { timeoutMs: 10_000 })
      .catch(() => undefined);
    const value = Setting.safeParse(reply).data?.entries?.[0]?.value;
    if (typeof value !== "boolean" || value === this.enabled) return;
    this.enabled = value;
    this.put();
  }

  private stopList() {
    this.listTimer?.();
    this.listTimer = undefined;
  }

  /**
   * The machine shows Spade and it runs, the connection is ready and the app's scene is active:
   * its bots are worth reading.
   */
  private get listable(): boolean {
    return (
      !this.stopped &&
      this.active &&
      this.owner.connectionState().getSnapshot() === "ready" &&
      this.ready &&
      this.status?.hidden !== true
    );
  }

  /**
   * Read the bots now, then again on their interval while Spade runs: quickly while the tab or a
   * conversation shows (a conversation's bubbles name its bot from the list), slower otherwise.
   */
  private readList() {
    this.stopList();
    if (!this.listable || this.listReading) return;
    this.listReading = true;
    // A write since this read began (`saved`) is newer than what it brings back about the bots.
    const writes = this.writes;
    const read = (path: string) => spadeText(this.owner, this.deps.id, "GET", path);
    // Bots and groups are two reads, and each shows as it lands: one failing never hides the
    // other. A Spade before groups answers no list, and the list holds bots only.
    const agents = read("/v1/agents").then(
      (body) => {
        const listed = parseSpadeAgents(body);
        if (listed && writes === this.writes) this.agents = listed;
        this.listFailed = !listed;
        this.put();
      },
      // The last list stays while a read fails; it reads again on its own.
      () => {
        this.listFailed = true;
        this.put();
      },
    );
    const groups = read("/v1/groups").then(
      (body) => {
        const listed = parseSpadeGroups(body);
        if (!listed) return;
        this.groups = listed;
        this.put();
      },
      () => {},
    );
    void Promise.all([agents, groups]).finally(() => {
      this.listReading = false;
      this.put();
      this.publishOpen();
      this.markSeen();
      // Written to while out: read again now, so the list confirms the write.
      if (writes !== this.writes) this.readList();
      else this.scheduleList();
    });
  }

  /** The next read of the bots, at the pace for what shows and whether any works. */
  private scheduleList() {
    this.stopList();
    if (!this.listable || this.listReading) return;
    const pace = this.watching || this.open ? listEvery.shown : listEvery.away;
    const working =
      (this.agents?.some((agent) => agent.state !== "idle") ?? false) ||
      (this.groups?.some((group) => group.state !== "idle") ?? false);
    this.listTimer = this.deps.later(working ? pace.working : pace.idle, () => this.readList());
  }

  private put() {
    const status = this.status;
    this.sink.put("spade:state", () => ({
      type: "spade.state",
      // Undefined until the daemon first answers: the tab bar keeps what it last knew.
      shown: status === undefined ? null : status.hidden !== true,
      line: spadePlaceLine(status, this.enabled),
      list: {
        // Bots and groups each show once read; null only while neither has been.
        rows:
          this.agents || this.groups
            ? spadeListRows(
                this.agents ?? [],
                this.groups ?? [],
                this.machine ?? "its machine",
                this.ready,
                this.hostId,
              )
            : null,
        // The bots couldn't be read and none are known: the list says so, with Try again.
        failed: this.agents === undefined && this.listFailed,
      },
    }));
  }

  private openConversation(conversationId: string | null, group?: string) {
    const open = this.open;
    if (open?.id === conversationId && (open?.kind === "group" ? open.group : undefined) === group)
      return;
    open?.stop();
    this.open = undefined;
    this.sent.clear();
    this.order = [];
    this.sink.clear("spade:row:");
    if (conversationId === null) {
      this.sink.put("spade:conversation", () => ({ type: "spade.conversation.closed" }));
      return;
    }
    const link: SpadeFollowLink = {
      canOpen: () => this.live.canOpen(),
      onOpenable: (listener) => this.live.onOpenable(listener),
      open: (path, sink) => this.live.open(path, sink),
      read: (path) => spadeText(this.owner, this.deps.id, "GET", path),
    };
    const deps = {
      // The pump already sends at most one frame at a time; a short wait gathers deltas.
      frame: (callback: () => void) => void this.deps.later(16, callback),
      later: this.deps.later,
    };
    const track = (follow: SpadeConversationFollow | SpadeGroupFollow) => {
      const unsubscribe = follow.subscribe(() => {
        if (this.open?.follow === follow) this.publishOpen();
      });
      return () => {
        unsubscribe();
        follow.stop();
      };
    };
    if (group === undefined) {
      const follow = new SpadeConversationFollow(link, conversationId, deps);
      this.open = { kind: "bot", id: conversationId, follow, stop: track(follow) };
    } else {
      const follow = new SpadeGroupFollow(link, conversationId, deps);
      this.open = { kind: "group", id: conversationId, group, follow, stop: track(follow) };
    }
    const { follow } = this.open;
    follow.start();
    follow.setReady(this.ready);
    // Spade's state may not be known yet; reading it lets the stream open once it is ready.
    if (!this.status) this.ask();
    this.publishOpen();
    if (!this.agents) this.readList();
  }

  private botOf(conversationId: string): SpadeAgent | undefined {
    return this.agents?.find((agent) => agent.conversation === conversationId);
  }

  /** The bot a conversation belongs to, by name, once the list has said; undefined before. */
  botName(conversationId: string): string | undefined {
    return this.botOf(conversationId)?.name || undefined;
  }

  /** A bot as the list last read it. */
  bot(id: string): SpadeAgent | undefined {
    return this.agents?.find((agent) => agent.id === id);
  }

  /**
   * A bot's task as a save just left it. Only the task: the write's answer leaves out what the
   * list carries beside the bot (its computer, its work), which must not go blank. The list
   * shows it now, and a read already out is dropped and made again (`readList`).
   */
  saved(id: string, task: string): void {
    if (!this.agents?.some((agent) => agent.id === id)) return;
    this.agents = this.agents.map((agent) => (agent.id === id ? { ...agent, task } : agent));
    this.writes++;
    this.put();
  }

  /** Spade's state and whether the machine's setting runs it, as last read. */
  get setting(): { status: SpadeStatus | undefined; enabled: boolean | undefined } {
    return { status: this.status, enabled: this.enabled };
  }

  /** Why Spade can't answer now, in a sentence ("Spade is starting."). */
  get placeSentence(): string {
    return spadePlaceLine(this.status, this.enabled).sentence;
  }

  /** The setting as a change from this phone just left it, before the daemon says so. */
  enabledNow(on: boolean): void {
    this.enabled = on;
    this.put();
  }

  /** Each bot's name by its id, as the list last read them. */
  get names(): ReadonlyMap<string, string> {
    return new Map((this.agents ?? []).map((agent) => [agent.id, agent.name]));
  }

  /** The machine's name, for a profile's Runs on. */
  get machineName(): string {
    return this.machine ?? "This machine";
  }

  /** A group's name, once the list has said; undefined before. */
  groupName(id: string): string | undefined {
    return this.groups?.find((group) => group.id === id)?.name || undefined;
  }

  /** The open conversation as it is now: its rows, its order and its head. */
  private publishOpen() {
    const open = this.open;
    if (!open) return;
    if (open.kind === "bot") {
      const { view, problem } = open.follow.get();
      const bot = this.botOf(open.id);
      this.putRows(open.id, spadeConversationRows(view, bot?.name || "Spade"));
      this.sink.put("spade:conversation", () =>
        spadeConversationHead(open.id, view, problem, bot ? botFace(bot) : null),
      );
      if (view.caughtUp) this.markSeen();
      return;
    }
    const { view, problem } = open.follow.get();
    const group = this.groups?.find((each) => each.id === open.group);
    const agents = this.agents ?? [];
    this.putRows(open.id, spadeGroupRows(view, group, agents, this.hostId));
    this.sink.put("spade:conversation", () =>
      spadeGroupHead(open.id, view, problem, group, agents, this.hostId),
    );
    if (view.live) this.markSeen();
  }

  /**
   * Put what changed: a row Swift already holds as it is now is never sent again, so a reply's
   * live words are one row per frame.
   */
  private putRows(id: string, rows: readonly { key: string; row: unknown }[]) {
    const order = rows.map(({ key }) => key);
    const kept = new Set(order);
    for (const key of this.sent.keys()) if (!kept.has(key)) this.sent.delete(key);
    for (const { key, row } of rows) {
      const text = JSON.stringify(row);
      if (this.sent.get(key) === text) continue;
      this.sent.set(key, text);
      this.sink.put(`spade:row:${key}`, () => ({
        type: "spade.row",
        conversation: id,
        key,
        row,
      }));
    }
    if (!sameOrder(order, this.order)) {
      this.order = order;
      this.sink.put("spade:order", () => ({ type: "spade.order", conversation: id, order }));
    }
  }

  /**
   * The open conversation is on screen and caught up: once Spade counts it unseen, mark it seen
   * up to its latest message, once per message, and read the list so its row settles.
   */
  private markSeen() {
    const open = this.open;
    if (!open) return;
    const caughtUp =
      open.kind === "bot" ? open.follow.get().view.caughtUp : open.follow.get().view.live;
    const seen =
      open.kind === "bot"
        ? this.botOf(open.id)
        : this.groups?.find((group) => group.id === open.group);
    if (!caughtUp || !seen?.unseen) return;
    const seq = seen.lastMessage?.seq;
    const mark = `${open.id}:${seq ?? "end"}`;
    if (this.seen === mark) return;
    this.seen = mark;
    void spadeText(
      this.owner,
      this.deps.id,
      "PUT",
      `/v1/conversations/${segment(open.id)}/seen`,
      seq === undefined ? {} : { seq },
    ).then(
      () => this.readList(),
      () => {
        // Tried again with the next list read.
        if (this.seen === mark) this.seen = undefined;
      },
    );
  }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
