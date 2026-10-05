import type { Fact } from "@ace/core";
import {
  applyDelivery,
  applyThreadListEvent,
  createThreadListView,
  createThreadView,
} from "@ace/projection";
import {
  EventId,
  HostId,
  ThreadId,
  WorkspaceId,
  type Command,
  type CommandResult,
  type DeliveryEvent,
  type EventPayload,
  type ItemsPage,
  type ServerMessage,
  type SubscriptionScope,
  type Thread,
  type ThreadListView,
  type ThreadView,
} from "@ace/protocol";
import { Connection, type Host, type Wire } from "./connection.ts";
import { replyUnsupported, type FakeWireSession } from "./services-wire.ts";
import {
  endTurn,
  finish,
  message,
  output,
  rootAgent,
  stream,
  tool,
  toolDone,
  turn,
} from "./scenarios/facts.ts";
import { ThreadHost } from "./thread-host.ts";
import { historyPage as syntheticPage } from "./soak-history.ts";
import { historyPage, windowSnapshot } from "./window.ts";

/*
 * An endless agent for soak and load tests: one thread whose root agent answers forever, each
 * exchange a user message, a streamed answer, a shell command with output and the turn's end.
 * Exchanges are folded through @ace/core once and replayed with fresh ids, and the daemon keeps
 * only a bounded window, so it can publish millions of events at a fixed memory cost; growth
 * measured in a client is the client's own.
 */

export interface SoakOptions {
  clock(): number;
  threadId?: string;
  /** Text deltas per streamed answer. */
  deltas?: number;
  /** Items the daemon keeps for snapshots and history pages. */
  windowItems?: number;
  /** Each exchange also asks for an approval and runs a background task, then ends both. */
  interactive?: boolean;
  /** Items of history made on demand below the live stream (a thread of this many items). */
  history?: number;
  /**
   * The answer each exchange streams, in deltas of `chunk` characters (20 by default), instead
   * of `deltas` pieces of a one-line sentence.
   */
  answer?: { text: string; chunk?: number };
}

const answer =
  "The replay window now caps at 200 events, and the resume handshake carries lastAckedSeq so the server can drop frames the client already has. ";

/** The pieces an exchange streams its answer in. */
function answerDeltas(options: SoakOptions): string[] {
  if (options.answer) {
    const { text, chunk = 20 } = options.answer;
    if (!Number.isInteger(chunk) || chunk < 1)
      throw new RangeError(`answer.chunk must be a positive integer, not ${chunk}`);
    const pieces: string[] = [];
    for (let at = 0; at < text.length; at += chunk) pieces.push(text.slice(at, at + chunk));
    return pieces;
  }
  return Array.from({ length: options.deltas ?? 24 }, (_, n) =>
    answer.slice((n * 24) % answer.length, ((n * 24) % answer.length) + 24),
  );
}

function exchange(deltas: readonly string[], interactive: boolean): Fact[] {
  const facts: Fact[] = [
    turn("root"),
    message("root", "ask", "user", "Run the relay suite again and summarise what changed."),
    message("root", "answer", "assistant", "", false),
  ];
  for (const delta of deltas) facts.push(stream("root", "answer", delta));
  facts.push(
    finish("root", "answer"),
    tool("root", "test", {
      kind: "shell",
      title: "bun run test apps/relay",
      detail: { kind: "shell", command: "bun run test apps/relay" },
    }),
    output("root", "test", " ✓ relay/replay.test.ts (12 tests)\n"),
    output("root", "test", " ✓ relay/outbox.test.ts (4 tests)\n"),
    toolDone("root", "test"),
  );
  if (interactive)
    facts.push(
      tool("root", "serve", {
        kind: "shell",
        title: "bun run relay --watch",
        status: "awaiting_approval",
        detail: { kind: "shell", command: "bun run relay --watch" },
      }),
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "approve-serve",
        blocking: true,
        item: "serve",
        request: {
          kind: "approval",
          title: "Run bun run relay --watch?",
          options: [{ id: "allow", label: "Allow once", kind: "allow_once" }],
        },
      },
      { type: "interaction.closed", interaction: "approve-serve", state: "resolved" },
      {
        type: "background.started",
        agent: "root",
        task: "relay",
        kind: "shell",
        title: "relay (watch)",
        item: "serve",
        stoppable: true,
      },
      { type: "background.ended", task: "relay", status: "completed" },
      toolDone("root", "serve"),
    );
  facts.push(endTurn("root"));
  return facts;
}

export class SoakDaemon implements Host {
  readonly hostId = HostId.parse("soak-host");
  readonly duplicateEvents = false;
  readonly threadId: string;
  private options: SoakOptions;
  private seq = 0;
  private view: ThreadView;
  private list: ThreadListView = createThreadListView();
  private creation = new Map<string, number>();
  private connections = new Set<Connection>();
  /** One exchange's payloads as JSON; ids made inside it are renumbered per cycle. */
  private template: string;
  private firstCycleId: number;
  private cycle = 0;
  private queued: EventPayload[] = [];
  constructor(options: SoakOptions) {
    this.options = options;
    this.threadId = options.threadId ?? "thread-soak";
    const now = options.clock();
    const thread: Thread = {
      id: ThreadId.parse(this.threadId),
      workspaceId: WorkspaceId.parse("acme-relay"),
      title: "Soak: relay replay under load",
      provider: "claude",
      status: { state: "new" },
      createdAt: now,
      updatedAt: now,
    };
    this.view = createThreadView(thread);
    // The made-up past owns creation sequences 1..history; the live stream starts above it.
    this.seq = options.history ?? 0;
    const host = new ThreadHost(thread);
    const setup: EventPayload[] = [
      { type: "thread.created", thread },
      ...host.fold(rootAgent("claude"), now),
    ];
    const cycle = exchange(answerDeltas(options), options.interactive ?? false).flatMap((fact) =>
      host.fold(fact, now),
    );
    this.template = JSON.stringify(cycle);
    // Ids core made during the exchange (items, runs, tools) are renumbered every cycle; ids
    // made during setup (the root agent) stay.
    const setupIds = new Set(this.ids(JSON.stringify(setup)));
    this.firstCycleId = Math.min(
      ...this.ids(this.template)
        .filter((id) => !setupIds.has(id))
        .map((id) => Number(id.split(".").pop())),
    );
    this.publish(setup);
  }
  /** Core-made ids (`<thread>.<kind>.<n>`) in a JSON text. */
  private ids(json: string): string[] {
    return json.match(new RegExp(`${this.threadId}\\.[a-z_]+\\.\\d+`, "g")) ?? [];
  }
  get head(): number {
    return this.seq;
  }
  get token(): string {
    return "soak-token";
  }
  /** Events published so far. */
  get events(): number {
    return this.seq;
  }
  accepts(credential: { token?: string | undefined }): boolean {
    return credential.token === this.token;
  }
  connect(wire: Wire): Connection {
    const connection = new Connection(this, wire);
    this.connections.add(connection);
    return connection;
  }
  release(connection: Connection): void {
    this.connections.delete(connection);
  }
  /** The soak serves no request/response services; only the thread stream is under load. */
  service(): boolean {
    return false;
  }
  session(send: (reply: ServerMessage) => void): FakeWireSession {
    return {
      close() {},
      handle: async (request) => replyUnsupported(request, send),
    };
  }
  snapshot(scope: SubscriptionScope): ThreadView | ThreadListView | undefined {
    if (scope.kind === "threads") return { ...structuredClone(this.list), seq: this.seq };
    if (scope.threadId !== this.threadId) return undefined;
    const view = windowSnapshot(
      this.view,
      this.creation,
      this.options.windowItems ?? 200,
      this.seq,
    );
    if (this.options.history && view.itemsBefore === null)
      view.itemsBefore = this.oldestLive() ?? this.seq + 1;
    return view;
  }
  /** Soak clients never resume from an old cursor; a replay asks for a snapshot instead. */
  replay(): DeliveryEvent[] {
    return [];
  }
  page(threadId: string, before: number, limit: number): ItemsPage | undefined {
    if (threadId !== this.threadId) return undefined;
    const live = historyPage(this.view, this.creation, before, limit, this.seq);
    const size = this.options.history;
    if (!size) return live;
    if (live.items.length) {
      // The live window's oldest item sits right above the made-up past.
      if (live.itemsBefore === null) live.itemsBefore = this.oldestLive() ?? null;
      return live;
    }
    return syntheticPage({
      threadId,
      agentId: this.view.thread.rootAgentId ?? "root",
      size,
      before,
      limit,
      seq: this.seq,
      at: this.options.clock(),
    });
  }
  /** Creation sequence of the oldest live item the daemon still keeps. */
  private oldestLive(): number | undefined {
    const first = this.view.itemOrder[0];
    return first === undefined ? undefined : this.creation.get(first);
  }
  command(command: Command): CommandResult {
    return { commandId: command.id, ok: false, error: "unsupported_by_soak_daemon" };
  }
  /** Publish the next `count` events, in batches of `batch` (one socket frame each). */
  pump(count: number, batch = 64): void {
    let left = count;
    while (left > 0) {
      const size = Math.min(batch, left);
      while (this.queued.length < size) this.queued.push(...this.nextCycle());
      this.publish(this.queued.splice(0, size));
      left -= size;
    }
  }
  private nextCycle(): EventPayload[] {
    const cycle = ++this.cycle;
    const pattern = new RegExp(`(${this.threadId}\\.[a-z_]+\\.)(\\d+)`, "g");
    const json = this.template.replace(pattern, (whole, prefix: string, n: string) =>
      Number(n) >= this.firstCycleId ? `${prefix}${n}~${cycle}` : whole,
    );
    const payloads: EventPayload[] = JSON.parse(json);
    return payloads;
  }
  private publish(payloads: EventPayload[]): void {
    const now = this.options.clock();
    const events = payloads.map((payload): DeliveryEvent => {
      const seq = ++this.seq;
      return {
        seq,
        id: EventId.parse(`event-${seq}`),
        at: now,
        threadId: ThreadId.parse(this.threadId),
        payload,
      };
    });
    for (const event of events) {
      applyDelivery(this.view, {
        type: "events",
        subscriptionId: "soak",
        afterSeq: this.view.seq,
        throughSeq: event.seq,
        events: [event],
      });
      applyThreadListEvent(this.list, event);
      if (event.payload.type === "item.created")
        this.creation.set(event.payload.item.id, event.seq);
    }
    this.trim();
    for (const connection of this.connections) connection.publish(events, this.seq);
  }
  /** Keep the daemon's own state bounded: the newest items and runs only. */
  private trim(): void {
    const keep = (this.options.windowItems ?? 200) * 2;
    const view = this.view;
    if (view.itemOrder.length > keep * 2) {
      const dropped = view.itemOrder.slice(0, view.itemOrder.length - keep);
      view.itemOrder = view.itemOrder.slice(-keep);
      for (const id of dropped) {
        delete view.items[id];
        this.creation.delete(id);
      }
    }
    for (const record of [view.runs, view.interactions, view.backgroundTasks]) {
      const ids = Object.keys(record);
      if (ids.length > 128) for (const id of ids.slice(0, ids.length - 64)) delete record[id];
    }
  }
}
