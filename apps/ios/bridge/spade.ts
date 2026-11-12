import { onSocketMove, type ClientCore } from "@ace/client";
import { spadeExchange } from "@ace/client/spade-http";
import { SpadeDaemonLive } from "@ace/client/spade-live";
import type { SpadeMethod, SpadeStatus } from "@ace/protocol";
import {
  parseSpadeConversations,
  SpadeConversationFollow,
  spadeRefusal,
  SpadeRequestError,
  spadeRowWorking,
  spadeStateLine,
  type SpadeConversationRow,
  type SpadeEntry,
  type SpadeFollowLink,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { spadeConversationPatch, spadeListRow, spadeRow } from "./spade-rows.ts";

/*
 * Spade on the iPhone (ADR 0121): always through the daemon's `spade.*` family, since the phone
 * never reaches Spade directly. Swift says what it shows (the Spade place, one conversation);
 * this follows Spade's state, its conversation list and that conversation, and puts rows for
 * Swift to draw. Requests with an outcome go through `NativeServices` (`spade-requests.ts`).
 */

export interface SpadeDeps {
  now(): number;
  id(): string;
  later(delay: number, callback: () => void): () => void;
}

export const NativeSpadeAction = z.discriminatedUnion("type", [
  /** The Spade place or Settings › Spade is on screen (or no longer is). */
  z.object({ type: z.literal("spade.watch"), on: z.boolean() }),
  /** Follow this conversation live, or none. */
  z.object({
    type: z.literal("spade.open"),
    conversationId: z.string().min(1).max(256).nullable(),
  }),
  /** Try following the open conversation again after a problem. */
  z.object({ type: z.literal("spade.retry") }),
]);
export type NativeSpadeAction = z.infer<typeof NativeSpadeAction>;

/** The list is read again this often: faster while any row works, as the web reads it. */
const listEvery = { working: 2_000, idle: 10_000 };

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
    throw new SpadeRequestError(spadeRefusal(answer.status, text), answer.status);
  return text;
}

export class NativeSpade {
  private status: SpadeStatus | undefined;
  private enabled: boolean | undefined;
  private rows: SpadeConversationRow[] | undefined;
  private listFailed = false;
  private watching = false;
  /** Places on screen that watch (the Spade tab, Settings › Spade); the watch ends at none. */
  private watchers = 0;
  private stops: (() => void)[] = [];
  private listTimer: (() => void) | undefined;
  private listReading = false;
  private asked = 0;
  private open: { id: string; follow: SpadeConversationFollow; stop: () => void } | undefined;
  /** What Swift holds of the open conversation: each entry as last put, and their order. */
  private sent = new Map<string, SpadeEntry>();
  private order: readonly string[] = [];
  private readonly live: SpadeDaemonLive;
  private readonly owner: ClientCore;
  private readonly sink: PatchSink;
  private readonly deps: SpadeDeps;

  constructor(owner: ClientCore, sink: PatchSink, deps: SpadeDeps) {
    this.owner = owner;
    this.sink = sink;
    this.deps = deps;
    this.live = new SpadeDaemonLive(owner, deps.id);
  }

  get ready(): boolean {
    return this.status?.state === "ready";
  }

  /** The open conversation's follow, for sends that should show at once. */
  follow(conversationId: string): SpadeConversationFollow | undefined {
    return this.open?.id === conversationId ? this.open.follow : undefined;
  }

  handle(action: NativeSpadeAction): void {
    switch (action.type) {
      case "spade.watch":
        this.watchers = Math.max(0, this.watchers + (action.on ? 1 : -1));
        return this.watchers > 0 ? this.watch() : this.unwatch();
      case "spade.open":
        return this.openConversation(action.conversationId);
      case "spade.retry":
        return this.open?.follow.retry();
    }
  }

  /** This runtime is going away: every watch, poll and stream ends. */
  stop(): void {
    this.watchers = 0;
    this.unwatch();
    this.openConversation(null);
  }

  /** Spade's state, the setting and the list are out of date: read them again now. */
  refresh(): void {
    if (!this.watching) return;
    this.ask();
    void this.readEnabled();
    this.readList();
  }

  private watch() {
    if (this.watching) return;
    this.watching = true;
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
    // The daemon's status watch ends with the socket: ask again on every new one.
    this.stops.push(
      connection.subscribe(() => {
        if (connection.getSnapshot() === "ready") this.refresh();
      }),
      onSocketMove(this.owner, () => this.refresh()),
    );
    this.put();
    this.refresh();
  }

  private unwatch() {
    this.watching = false;
    for (const stop of this.stops.splice(0)) stop();
    this.listTimer?.();
    this.listTimer = undefined;
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

  /** Read the list now, then again on its interval while the place shows and Spade runs. */
  private readList() {
    this.listTimer?.();
    this.listTimer = undefined;
    if (!this.watching || !this.ready || this.listReading) return;
    this.listReading = true;
    void spadeText(this.owner, this.deps.id, "GET", "/v1/conversations")
      .then(
        (body) => {
          const rows = parseSpadeConversations(body);
          if (rows) this.rows = rows;
          this.listFailed = !rows;
        },
        // The last list stays while a read fails; it reads again on its own.
        () => {
          this.listFailed = true;
        },
      )
      .finally(() => {
        this.listReading = false;
        this.put();
        if (!this.watching || !this.ready) return;
        const working = this.rows?.some(spadeRowWorking) ?? false;
        this.listTimer = this.deps.later(working ? listEvery.working : listEvery.idle, () =>
          this.readList(),
        );
      });
  }

  private put() {
    this.sink.put("spade:state", () => ({
      type: "spade.state",
      line: spadeStateLine(this.status, this.enabled),
      enabled: this.enabled ?? null,
      list: {
        rows: this.rows?.map((row) => spadeListRow(row, this.deps.now())) ?? null,
        failed: this.rows === undefined && this.listFailed,
      },
    }));
  }

  private openConversation(conversationId: string | null) {
    if (this.open?.id === conversationId) return;
    this.open?.stop();
    this.open = undefined;
    this.sent.clear();
    this.order = [];
    this.sink.clear("spade:entry:");
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
    const follow = new SpadeConversationFollow(link, conversationId, {
      // The pump already sends at most one frame at a time; a short wait gathers deltas.
      frame: (callback) => void this.deps.later(16, callback),
      later: this.deps.later,
    });
    const unsubscribe = follow.subscribe(() => this.publish(conversationId, follow));
    this.open = {
      id: conversationId,
      follow,
      stop: () => {
        unsubscribe();
        follow.stop();
      },
    };
    follow.start();
    follow.setReady(this.ready);
    // Spade's state may not be known yet; reading it lets the stream open once it is ready.
    if (!this.status) this.ask();
    this.publish(conversationId, follow);
  }

  /**
   * Put what changed: the fold replaces an entry only when it changes, so an entry Swift
   * already holds is never sent again, and a reply's live words are one entry per frame.
   */
  private publish(id: string, follow: SpadeConversationFollow) {
    if (this.open?.follow !== follow) return;
    const { view, problem } = follow.get();
    const order = view.entries.map((entry) => entry.key);
    const kept = new Set(order);
    for (const key of this.sent.keys()) if (!kept.has(key)) this.sent.delete(key);
    for (const entry of view.entries) {
      if (this.sent.get(entry.key) === entry) continue;
      this.sent.set(entry.key, entry);
      this.sink.put(`spade:entry:${entry.key}`, () => ({
        type: "spade.entry",
        conversation: id,
        key: entry.key,
        row: spadeRow(entry),
      }));
    }
    if (!sameOrder(order, this.order)) {
      this.order = order;
      this.sink.put("spade:order", () => ({ type: "spade.order", conversation: id, order }));
    }
    this.sink.put("spade:conversation", () => spadeConversationPatch(id, view, problem));
  }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
