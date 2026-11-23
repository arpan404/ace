import { onSocketMove, type ClientCore } from "@ace/client";
import type { SpadeStatus } from "@ace/protocol";
import {
  SpadeConversationFollow,
  SpadeGroupFollow,
  type SpadeAgent,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { SpadeHosting } from "./spade-hosting.ts";
import { spadeListRows, spadePlaceLine } from "./spade-rows.ts";
import { SpadePeople, SpadeSharing } from "./spade-sharing.ts";
import { followCheckpoint } from "./inbox-checkpoint.ts";
import { spadeCheckpoint, spadeKeepable, type SpadeKnown } from "./spade-checkpoint.ts";
import type { SpadeKeep } from "./spade-kept-events.ts";
import { SpadeList } from "./spade-list.ts";
import { SpadeOpenChat } from "./spade-open.ts";
import { spadeText } from "./spade-text.ts";

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
  /** Where opened conversations' events are kept between launches (`spade-kept-events.ts`). */
  keep?: SpadeKeep;
  /** Keeps what the next launch draws first, before its runtime starts (`spade-checkpoint.ts`). */
  checkpoint?(json: string): void;
  /**
   * Whose kept state this is: the principal the connection signs in as, on this machine
   * (`KeptScope.swift`). Without one nothing is kept or shown from before.
   */
  scope?: string;
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
  /** Who the person is and their organizations' members' names, for a shared bot's requests. */
  z.object({ type: z.literal("spade.people"), people: SpadePeople }),
]);
export type NativeSpadeAction = z.infer<typeof NativeSpadeAction>;

const Setting = z.object({ entries: z.array(z.object({ value: z.unknown() })).optional() });

export class NativeSpade {
  private status: SpadeStatus | undefined;
  private enabled: boolean | undefined;
  private watching = false;
  /** This runtime went away: nothing reads again. */
  private stopped = false;
  /** The app's scene is active: in the background or behind the lock screen nothing reads. */
  private active = true;
  private stops: (() => void)[] = [];
  private asked = 0;
  /** The machine's bots and groups, as last read. */
  private readonly list: SpadeList;
  /** The one conversation open on the phone, live. */
  private readonly chat: SpadeOpenChat;
  /** The Spade tab as the next launch draws it first, written a while after it last changed. */
  private readonly checkpoint: ReturnType<typeof followCheckpoint>;
  /** Which bots an organization shares, on an org host (ADR 0206 §2.3). */
  private readonly sharing: SpadeSharing;
  /** Where this machine's Spade says Spade lives, for the list across machines. */
  private readonly hosting: SpadeHosting;
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
    this.checkpoint = followCheckpoint(
      { now: deps.now, set: deps.later },
      () => spadeKeepable(this.known),
      () => spadeCheckpoint(this.known),
      (json) => deps.checkpoint?.(json),
    );
    this.list = new SpadeList({
      owner,
      id: deps.id,
      later: deps.later,
      listable: () => this.listable,
      ready: () => this.ready,
      shown: () => this.watching || this.chat.showing,
      reading: () => this.hosting.readDue(),
      listed: (agents) => this.sharing.follow(agents),
      changed: () => this.put(),
      settled: () => {
        this.put();
        this.chat.listed();
      },
    });
    this.chat = new SpadeOpenChat({
      owner,
      sink,
      id: deps.id,
      later: deps.later,
      ready: () => this.ready,
      agents: () => this.list.agents,
      groups: () => this.list.groups,
      hostId: () => this.hostId,
      approvers: (bot) => this.sharing.approvers(bot),
      readList: () => this.list.read(),
      keep: deps.keep,
      scope: deps.scope,
      whenAuthenticated: (callback) => {
        const connection = owner.connectionState();
        if (connection.getSnapshot() === "ready") {
          callback();
          return () => {};
        }
        const stop = connection.subscribe(() => {
          if (connection.getSnapshot() !== "ready") return;
          stop();
          callback();
        });
        return stop;
      },
    });
    this.hosting = new SpadeHosting({
      read: (path) => spadeText(owner, deps.id, "GET", path),
      now: deps.now,
      changed: () => this.put(),
    });
    this.sharing = new SpadeSharing({
      read: (path) => spadeText(owner, deps.id, "GET", path),
      now: deps.now,
      changed: () => {
        this.put();
        this.chat.publish();
      },
    });
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
        // A dropped connection ends the list's timer, and its bots list as away; it reads again
        // once ready.
        if (connection.getSnapshot() === "ready") return this.refresh();
        this.list.dropped();
        this.put();
      }),
      onSocketMove(this.owner, () => this.refresh()),
    );
    this.refresh();
  }

  /** The open conversation's follow, for sends that should show at once. */
  follow(conversationId: string): SpadeConversationFollow | undefined {
    return this.chat.follow(conversationId);
  }

  /** The open group's follow, for posts that should show at once. */
  groupFollow(conversationId: string): SpadeGroupFollow | undefined {
    return this.chat.groupFollow(conversationId);
  }

  handle(action: NativeSpadeAction): void {
    switch (action.type) {
      case "spade.watch":
        this.watching = action.on;
        // Shown, the list is read at once; put away, it goes on at the slower pace.
        return action.on ? this.list.read() : this.list.schedule();
      case "spade.open":
        return this.openConversation(action.conversationId, action.group);
      case "spade.retry":
        return this.chat.retry();
      case "spade.active":
        if (action.active === this.active) return;
        this.active = action.active;
        return action.active ? this.list.read() : this.list.stop();
      case "spade.refresh":
        this.sharing.refresh();
        return this.refresh();
      case "spade.people":
        return this.sharing.setPeople(action.people);
    }
  }

  /** This runtime is going away: every watch, poll and stream ends. */
  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.stopped = true;
    this.watching = false;
    this.list.stop();
    this.checkpoint.stop();
    this.chat.show(null);
  }

  /** Spade's state, the setting and the bots are out of date: read them again now. */
  refresh(): void {
    this.ask();
    void this.readName();
    void this.readEnabled();
    if (this.listable) this.hosting.readNow();
    this.list.read();
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
    this.chat.setReady(this.ready);
    // Turning Spade on or off changes the setting first; the status says it took.
    if (this.ready !== wasReady) {
      void this.readEnabled();
      this.list.read();
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
    this.chat.publish();
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

  /** What this runtime knows of Spade, for the next launch's checkpoint. */
  private get known(): SpadeKnown {
    return {
      status: this.status,
      confirmed: this.list.confirmed,
      agents: this.list.agents,
      groups: this.list.groups,
      machine: this.machine ?? "its machine",
      hostId: this.hostId,
      host: this.hosting.here ?? this.hostId ?? null,
      main: this.hosting.wire,
      sharedIn: (agent) => this.sharing.sharedIn(agent),
    };
  }

  private put() {
    if (this.deps.checkpoint && this.deps.scope && !this.stopped) this.checkpoint.touch();
    const status = this.status;
    const { agents, groups } = this.list;
    this.sink.put("spade:state", () => ({
      type: "spade.state",
      // Undefined until the daemon first answers: the tab bar keeps what it last knew.
      shown: status === undefined ? null : status.hidden !== true,
      line: spadePlaceLine(status, this.enabled),
      // The machine's ace host id, as host records name it; null until it has said.
      host: this.hosting.here ?? this.hostId ?? null,
      main: this.hosting.wire,
      list: {
        // Bots and groups each show once read; null only while neither has been.
        rows:
          agents || groups
            ? spadeListRows(
                agents ?? [],
                groups ?? [],
                this.machine ?? "its machine",
                this.list.reach,
                this.hostId,
                (agent) => this.sharing.sharedIn(agent),
              )
            : null,
        // The bots couldn't be read and none are known: the list says so, with Try again.
        failed: this.list.failed,
      },
    }));
  }

  private openConversation(conversationId: string | null, group?: string) {
    this.chat.show(conversationId, group);
    if (conversationId === null) return;
    // Spade's state may not be known yet; reading it lets the stream open once it is ready.
    if (!this.status) this.ask();
    if (!this.list.agents) this.list.read();
  }

  private botOf(conversationId: string): SpadeAgent | undefined {
    return this.list.agents?.find((agent) => agent.conversation === conversationId);
  }

  /** The bot a conversation belongs to, by name, once the list has said; undefined before. */
  botName(conversationId: string): string | undefined {
    return this.botOf(conversationId)?.name || undefined;
  }

  /** A bot as the list last read it. */
  bot(id: string): SpadeAgent | undefined {
    return this.list.agents?.find((agent) => agent.id === id);
  }

  /** A bot's task as a save just left it (`SpadeList.saved`). */
  saved(id: string, task: string): void {
    if (this.list.saved(id, task)) this.put();
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
    return new Map((this.list.agents ?? []).map((agent) => [agent.id, agent.name]));
  }

  /** The machine's name, for a profile's Runs on. */
  get machineName(): string {
    return this.machine ?? "This machine";
  }

  /** This machine's ace host id, as groups name their members' machines; undefined until said. */
  get host(): string | undefined {
    return this.hostId;
  }

  /** A group's name, once the list has said; undefined before. */
  groupName(id: string): string | undefined {
    return this.list.groups?.find((group) => group.id === id)?.name || undefined;
  }
}
