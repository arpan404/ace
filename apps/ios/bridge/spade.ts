import { onSocketMove, type ClientCore } from "@ace/client";
import { spadeExchange } from "@ace/client/spade-http";
import { SpadeDaemonLive } from "@ace/client/spade-live";
import type { SpadeMethod, SpadeStatus } from "@ace/protocol";
import {
  parseSpadeAgents,
  parseSpadeModels,
  spadeBubbles,
  SpadeConversationFollow,
  spadeRefusal,
  SpadeRequestError,
  spadeRoster,
  spadeSetupSentence,
  spadeStateLine,
  type SpadeAgent,
  type SpadeFollowLink,
  type SpadeModels,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import {
  sameSpadeRow,
  spadeBubbleRow,
  spadeConversationPatch,
  spadeRosterRow,
  type SpadeBubbleRow,
} from "./spade-rows.ts";

/*
 * Spade on the iPhone (ADR 0121, 0127): always through the daemon's `spade.*` family, since the
 * phone never reaches Spade directly. Swift says what it shows (the Spade place, one bot's
 * conversation); this follows Spade's state, its roster of bots and that conversation, and puts
 * rows for Swift to draw. Requests with an outcome go through `NativeServices`
 * (`spade-requests.ts`).
 */

export interface SpadeDeps {
  now(): number;
  id(): string;
  later(delay: number, callback: () => void): () => void;
}

const id = z.string().min(1).max(256);

export const NativeSpadeAction = z.discriminatedUnion("type", [
  /** The Spade place or Settings › Spade is on screen (or no longer is). */
  z.object({ type: z.literal("spade.watch"), on: z.boolean() }),
  /** Follow this bot's one conversation live, or none. */
  z.object({
    type: z.literal("spade.open"),
    bot: z.object({ agentId: id, conversationId: id }).nullable(),
  }),
  /** Try following the open conversation again after a problem. */
  z.object({ type: z.literal("spade.retry") }),
  /** Pull to refresh: read Spade's state, the setting and the roster again now. */
  z.object({ type: z.literal("spade.refresh") }),
]);
export type NativeSpadeAction = z.infer<typeof NativeSpadeAction>;

/** The roster is read again this often: faster while any bot works, as the web reads it. */
const rosterEvery = { working: 2_000, idle: 10_000 };

const Setting = z.object({ entries: z.array(z.object({ value: z.unknown() })).optional() });

/** A path segment from an id Spade gave us. */
export const segment = (value: string) => encodeURIComponent(value);

/** One request to Spade through the daemon: its text on 2xx, else a `SpadeRequestError`. */
export async function spadeText(
  owner: ClientCore,
  newId: () => string,
  method: SpadeMethod,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const answer = await spadeExchange(
    owner,
    { method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { id: newId, signal },
  );
  if (answer.kind === "error") throw new SpadeRequestError(answer.message, undefined, answer.code);
  const text = answer.encoding === "text" ? answer.body : "";
  if (answer.status < 200 || answer.status > 299)
    throw new SpadeRequestError(spadeRefusal(answer.status, text), answer.status);
  return text;
}

interface Open {
  agentId: string;
  conversationId: string;
  follow: SpadeConversationFollow;
  stop: () => void;
}

export class NativeSpade {
  private status: SpadeStatus | undefined;
  private enabled: boolean | undefined;
  private agents: SpadeAgent[] | undefined;
  private rosterFailed = false;
  /** Endpoint names by id, for a failed reply's sentence; read with Settings › Spade's models. */
  private endpointNames = new Map<string, string>();
  private watching = false;
  /** Places on screen that watch (the Spade tab, Settings › Spade); the watch ends at none. */
  private watchers = 0;
  private stops: (() => void)[] = [];
  private rosterTimer: (() => void) | undefined;
  private rosterReading = false;
  private asked = 0;
  private open: Open | undefined;
  /** What Swift holds of the open conversation: each bubble's row as last put, and their order. */
  private sent = new Map<string, SpadeBubbleRow>();
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
    return this.open?.conversationId === conversationId ? this.open.follow : undefined;
  }

  /** Settings › Spade read the models: keep the endpoints' names for failed replies. */
  models(models: SpadeModels): void {
    this.endpointNames = new Map(models.endpoints.map((endpoint) => [endpoint.id, endpoint.name]));
  }

  handle(action: NativeSpadeAction): void {
    switch (action.type) {
      case "spade.watch":
        this.watchers = Math.max(0, this.watchers + (action.on ? 1 : -1));
        return this.watchers > 0 ? this.watch() : this.unwatch();
      case "spade.open":
        return this.openConversation(action.bot);
      case "spade.retry":
        return this.open?.follow.retry();
      case "spade.refresh":
        return this.refresh();
    }
  }

  /** This runtime is going away: every watch, poll and stream ends. */
  stop(): void {
    this.watchers = 0;
    this.unwatch();
    this.openConversation(null);
  }

  /** Spade's state, the setting and the roster are out of date: read them again now. */
  refresh(): void {
    if (!this.watching) return;
    this.ask();
    void this.readEnabled();
    this.readRoster();
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
    this.rosterTimer?.();
    this.rosterTimer = undefined;
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
      this.readRoster();
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

  /** Read the roster now, then again on its interval while the place shows and Spade runs. */
  private readRoster() {
    this.rosterTimer?.();
    this.rosterTimer = undefined;
    if (!this.watching || !this.ready || this.rosterReading) return;
    this.rosterReading = true;
    void spadeText(this.owner, this.deps.id, "GET", "/v1/agents")
      .then(
        (body) => {
          const agents = parseSpadeAgents(body);
          if (agents) this.agents = spadeRoster(agents);
          this.rosterFailed = !agents;
        },
        // The last roster stays while a read fails; it reads again on its own.
        () => {
          this.rosterFailed = true;
        },
      )
      .finally(() => {
        this.rosterReading = false;
        this.put();
        if (this.open) this.publish(this.open);
        if (!this.watching || !this.ready) return;
        const working = this.agents?.some((agent) => agent.state !== "idle") ?? false;
        this.rosterTimer = this.deps.later(working ? rosterEvery.working : rosterEvery.idle, () =>
          this.readRoster(),
        );
      });
  }

  private put() {
    this.sink.put("spade:state", () => ({
      type: "spade.state",
      line: spadeStateLine(this.status, this.enabled),
      // Running but waiting on the person (a keychain prompt): said in the same quiet line.
      setup: spadeSetupSentence(this.status) ?? null,
      enabled: this.enabled ?? null,
      roster: {
        rows: this.agents?.map((agent) => spadeRosterRow(agent, this.deps.now())) ?? null,
        failed: this.agents === undefined && this.rosterFailed,
      },
    }));
  }

  private openConversation(bot: { agentId: string; conversationId: string } | null) {
    if (this.open?.agentId === bot?.agentId && this.open?.conversationId === bot?.conversationId)
      return;
    this.open?.stop();
    this.open = undefined;
    this.sent.clear();
    this.order = [];
    this.sink.clear("spade:bubble:");
    if (bot === null) {
      this.sink.put("spade:conversation", () => ({ type: "spade.conversation.closed" }));
      return;
    }
    const link: SpadeFollowLink = {
      canOpen: () => this.live.canOpen(),
      onOpenable: (listener) => this.live.onOpenable(listener),
      open: (path, sink) => this.live.open(path, sink),
      read: (path) => spadeText(this.owner, this.deps.id, "GET", path),
    };
    const follow = new SpadeConversationFollow(link, bot.conversationId, {
      // The pump already sends at most one frame at a time; a short wait gathers deltas.
      frame: (callback) => void this.deps.later(16, callback),
      later: this.deps.later,
    });
    const open: Open = { ...bot, follow, stop: () => {} };
    const unsubscribe = follow.subscribe(() => this.publish(open));
    open.stop = () => {
      unsubscribe();
      follow.stop();
    };
    this.open = open;
    follow.start();
    follow.setReady(this.ready);
    // Spade's state may not be known yet; reading it lets the stream open once it is ready.
    if (!this.status) this.ask();
    this.publish(open);
  }

  /**
   * Put what changed: a bubble whose row reads the same is never sent again, and a reply's
   * live words are one bubble per frame.
   */
  private publish(open: Open) {
    if (this.open !== open) return;
    const { view, problem } = open.follow.get();
    const context = {
      botName: this.agents?.find((agent) => agent.id === open.agentId)?.name ?? "Spade",
      endpointName: (endpoint: string) => this.endpointNames.get(endpoint),
    };
    const bubbles = spadeBubbles(view);
    const order = bubbles.map((bubble) => bubble.key);
    const kept = new Set(order);
    for (const key of this.sent.keys()) if (!kept.has(key)) this.sent.delete(key);
    for (const bubble of bubbles) {
      const row = spadeBubbleRow(bubble, context);
      const before = this.sent.get(bubble.key);
      if (before && sameSpadeRow(before, row)) continue;
      this.sent.set(bubble.key, row);
      this.sink.put(`spade:bubble:${bubble.key}`, () => ({
        type: "spade.bubble",
        agentId: open.agentId,
        key: bubble.key,
        row,
      }));
    }
    if (!sameOrder(order, this.order)) {
      this.order = order;
      this.sink.put("spade:order", () => ({
        type: "spade.order",
        agentId: open.agentId,
        order,
      }));
    }
    this.sink.put("spade:conversation", () => spadeConversationPatch(open.agentId, view, problem));
  }
}

/** `GET /v1/models` parsed, or a refusal in words. */
export function readSpadeModels(body: string): SpadeModels {
  const models = parseSpadeModels(body);
  if (!models) throw new SpadeRequestError("Spade's model list didn't make sense.");
  return models;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
