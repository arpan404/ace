import type { ClientCore } from "@ace/client";
import { SpadeDaemonLive } from "@ace/client/spade-live";
import {
  SpadeConversationFollow,
  SpadeGroupFollow,
  type SpadeAgent,
  type SpadeFollowLink,
  type SpadeGroup,
} from "@ace/ui-core/spade-chat";
import type { PatchSink } from "./agents.ts";
import { botFace, spadeGroupHead, spadeGroupRows } from "./spade-group-rows.ts";
import { spadeConversationHead, spadeConversationRows } from "./spade-rows.ts";
import { segment, spadeText } from "./spade-text.ts";
import { SpadeWorkerTree } from "./spade-worker-tree.ts";
import { SpadeWorkerWatch } from "./spade-worker-watch.ts";

/*
 * The one Spade conversation open on the phone, followed live (`@ace/ui-core/spade-chat`): its
 * rows as Swift draws them, only those that changed, and the seen mark once it is caught up.
 * The list it names bots and groups from is the runtime's (`spade.ts`).
 */

/** What the open conversation reads from the runtime around it. */
export interface SpadeOpenHost {
  owner: ClientCore;
  sink: PatchSink;
  id(): string;
  later(delay: number, callback: () => void): () => void;
  /** Spade runs: a live stream may open. */
  ready(): boolean;
  /** The bots and groups as last read; undefined until first read. */
  agents(): SpadeAgent[] | undefined;
  groups(): SpadeGroup[] | undefined;
  /** The machine's host id, so group members match local roster bots. */
  hostId(): string | undefined;
  /** Who may answer a shared bot's requests (ADR 0206 §2.3). */
  approvers(bot: string): string | null;
  /** Read the bots again now, so a row settles once its conversation is seen. */
  readList(): void;
}

/** The conversation open on the phone: a bot's, or a group's. */
type Open = { id: string; stop: () => void } & (
  | { kind: "bot"; follow: SpadeConversationFollow }
  | { kind: "group"; group: string; follow: SpadeGroupFollow }
);

export class SpadeOpenChat {
  private open: Open | undefined;
  /** What Swift holds of the open conversation: each row as last put, and their order. */
  private sent = new Map<string, string>();
  private order: readonly string[] = [];
  /** The seen mark last sent, `conversation:seq`, so each latest message is marked once. */
  private seen: string | undefined;
  private readonly live: SpadeDaemonLive;
  /** The open chat's ace workers as ace lists their threads. */
  private readonly workers: SpadeWorkerWatch;
  /** The open chat's bot's tree, for whether a bot worker has started or finished. */
  private readonly tree: SpadeWorkerTree;
  private readonly host: SpadeOpenHost;

  constructor(host: SpadeOpenHost) {
    this.host = host;
    this.live = new SpadeDaemonLive(host.owner, host.id);
    this.workers = new SpadeWorkerWatch(host.owner, () => this.publish());
    this.tree = new SpadeWorkerTree({ read: (path) => this.read(path), later: host.later }, () =>
      this.publish(),
    );
  }

  /** Whether a conversation is open: the bots are read at the faster pace then. */
  get showing(): boolean {
    return this.open !== undefined;
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

  retry(): void {
    this.open?.follow.retry();
  }

  /** Spade runs (or no longer does): the live stream opens once it does. */
  setReady(ready: boolean): void {
    this.open?.follow.setReady(ready);
  }

  /** The list was read again: names, faces and the seen mark follow it. */
  listed(): void {
    this.publish();
    this.markSeen();
  }

  /** Follow `conversationId` live, or none; a group's (ADR 0132) names its group. */
  show(conversationId: string | null, group?: string): void {
    const open = this.open;
    if (open?.id === conversationId && (open?.kind === "group" ? open.group : undefined) === group)
      return;
    open?.stop();
    this.open = undefined;
    this.workers.stop();
    this.tree.stop();
    this.sent.clear();
    this.order = [];
    this.host.sink.clear("spade:row:");
    if (conversationId === null) {
      this.host.sink.put("spade:conversation", () => ({ type: "spade.conversation.closed" }));
      return;
    }
    const link: SpadeFollowLink = {
      canOpen: () => this.live.canOpen(),
      onOpenable: (listener) => this.live.onOpenable(listener),
      open: (path, sink) => this.live.open(path, sink),
      read: (path) => this.read(path),
    };
    const deps = {
      // The pump already sends at most one frame at a time; a short wait gathers deltas.
      frame: (callback: () => void) => void this.host.later(16, callback),
      later: this.host.later,
    };
    const track = (follow: SpadeConversationFollow | SpadeGroupFollow) => {
      const unsubscribe = follow.subscribe(() => {
        if (this.open?.follow === follow) this.publish();
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
    follow.setReady(this.host.ready());
    this.publish();
  }

  private read(path: string): Promise<string> {
    return spadeText(this.host.owner, this.host.id, "GET", path);
  }

  private botOf(conversationId: string): SpadeAgent | undefined {
    return this.host.agents()?.find((agent) => agent.conversation === conversationId);
  }

  /** The open conversation as it is now: its rows, its order and its head. */
  publish(): void {
    const open = this.open;
    if (!open) return;
    const { sink } = this.host;
    if (open.kind === "bot") {
      const { view, problem } = open.follow.get();
      const bot = this.botOf(open.id);
      const facts = this.workers.facts(
        () => this.host.agents(),
        (id) => this.tree.node(id),
      );
      const approvers = bot ? this.host.approvers(bot.id) : null;
      const rows = spadeConversationRows(view, bot?.name || "Spade", facts, approvers);
      this.workers.showing(rows);
      this.tree.showing(bot?.id, rows);
      this.putRows(open.id, rows);
      sink.put("spade:conversation", () =>
        spadeConversationHead(open.id, view, problem, bot ? botFace(bot) : null),
      );
      if (view.caughtUp) this.markSeen();
      return;
    }
    const { view, problem } = open.follow.get();
    const groups = this.host.groups();
    const group = groups?.find((each) => each.id === open.group);
    const agents = this.host.agents() ?? [];
    const hostId = this.host.hostId();
    this.putRows(open.id, spadeGroupRows(view, group, agents, hostId));
    sink.put("spade:conversation", () =>
      spadeGroupHead(open.id, view, problem, group, agents, hostId),
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
      this.host.sink.put(`spade:row:${key}`, () => ({
        type: "spade.row",
        conversation: id,
        key,
        row,
      }));
    }
    if (!sameOrder(order, this.order)) {
      this.order = order;
      this.host.sink.put("spade:order", () => ({ type: "spade.order", conversation: id, order }));
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
        : this.host.groups()?.find((group) => group.id === open.group);
    if (!caughtUp || !seen?.unseen) return;
    const seq = seen.lastMessage?.seq;
    const mark = `${open.id}:${seq ?? "end"}`;
    if (this.seen === mark) return;
    this.seen = mark;
    void spadeText(
      this.host.owner,
      this.host.id,
      "PUT",
      `/v1/conversations/${segment(open.id)}/seen`,
      seq === undefined ? {} : { seq },
    ).then(
      () => this.host.readList(),
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
