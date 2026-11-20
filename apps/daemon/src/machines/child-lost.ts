import {
  InteractionId,
  type Command,
  type CommandResult,
  type HostId,
  type InteractionRequest,
  type MachineThreadView,
  type ThreadId,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import { childAgentKey } from "../engine/remote-child-status.ts";
import type { Engine } from "../engine/index.ts";
import { savedView, type ChildLedger, type ChildRow } from "./child-ledger.ts";
import type { ChildResults } from "./child-results.ts";
import { questionFacts, questionFate } from "./child-question.ts";
import { abandonedView, lostLine, silentAbandonedView, unconfirmableView } from "./child-views.ts";
import type { RequestMirror } from "./mirror.ts";
import { parentGone } from "./parent-gone.ts";

/** The answer that stops tracking a lost child. */
export const STOP_TRACKING = "stop-tracking";

export interface LostChildrenDeps {
  store: Store;
  ledger: ChildLedger;
  /** The engine, for a child whose parent is still there to show it; undefined once it is gone. */
  engine(parent: ThreadId): Engine | undefined;
  now(): number;
  label(machine: string): string;
  host?(machine: string): HostId | undefined;
  results: ChildResults;
  mirror: RequestMirror;
  emit(ids: readonly string[]): void;
  log(message: string, fields: Record<string, unknown>): void;
}

/** What the parent's approval asks the person about a lost child. */
function lostRequest(row: ChildRow, name: string): InteractionRequest {
  return {
    kind: "approval",
    title: `${lostLine(name)}.`,
    description: `Pair ${name} again to keep tracking ${row.role}, or stop tracking it here.`,
    options: [
      {
        id: STOP_TRACKING,
        label: `Stop tracking; its work on ${name} may still be running`,
        kind: "cancel",
      },
    ],
  };
}

/** "3:42 PM", or with its day once it isn't today: when the machine was last heard from. */
function clockWords(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/**
 * What the parent's approval asks about a child whose machine stopped answering: nothing to do
 * by default, since it closes itself when the machine answers; or stop tracking it.
 */
function silentRequest(
  row: ChildRow,
  name: string,
  since: number,
  now: number,
): InteractionRequest {
  return {
    kind: "approval",
    title: `Lost contact with ${name} since ${clockWords(since, now)}, so ace can't tell whether ${row.role} is still working there.`,
    description: `ace keeps waiting and asking; this closes by itself when ${name} answers. Or stop tracking ${row.role} here.`,
    options: [
      {
        id: STOP_TRACKING,
        label: `Stop tracking; its work on ${name} may still be running`,
        kind: "cancel",
      },
    ],
  };
}

/**
 * What the parent's approval asks about a settled child whose machine is no longer paired: its
 * result stands, but whether work started on it again there can't be seen any more.
 */
function lostSettledRequest(row: ChildRow, name: string): InteractionRequest {
  return {
    kind: "approval",
    title: `${name} is no longer paired, so ace can't see whether ${row.role} started again there.`,
    description: `Pair ${name} again to keep watching ${row.role}, or stop watching it; it keeps the result it ended with.`,
    options: [
      {
        id: STOP_TRACKING,
        label: `Stop watching; any new work on ${name} won't be seen here`,
        kind: "cancel",
      },
    ],
  };
}

/**
 * What the parent's approval asks about a child stopped here whose machine never confirmed it,
 * then was unpaired: nothing can confirm it now, and its work there may still be running.
 */
function lostUnconfirmedRequest(row: ChildRow, name: string): InteractionRequest {
  return {
    kind: "approval",
    title: `Lost contact when unpaired: ${name} never confirmed ${row.role} stopped, and is no longer paired, so its work there may still be running.`,
    description: `Pair ${name} again to keep sending the cancel until it confirms, or stop tracking ${row.role} here.`,
    options: [
      {
        id: STOP_TRACKING,
        label: `Stop tracking; its work on ${name} may still be running`,
        kind: "cancel",
      },
    ],
  };
}

/** What the parent asks about a settled child whose machine is no longer paired. */
const settledRequest = (row: ChildRow, name: string) =>
  row.stopped_unconfirmed === 1 ? lostUnconfirmedRequest(row, name) : lostSettledRequest(row, name);

/**
 * Children whose pairing is gone (ADR 0099). Nothing here can read, message or stop them, yet
 * their work there may still be running, so they never settle on their own: each stays lost,
 * its parent unresolved and asking the person, until the pairing returns (tracking resumes) or
 * the person stops tracking it (it settles cancelled, saying its work may still be running).
 */
export class LostChildren {
  private deps: LostChildrenDeps;
  private asks = 0;
  constructor(deps: LostChildrenDeps) {
    this.deps = deps;
  }
  /**
   * The child's pairing is gone: it is lost, and its parent asks the person. Called on every
   * poll that reaches it, so an approval that closed (its parent's session ended) opens again.
   */
  keep(row: ChildRow): void {
    const name = this.deps.label(row.machine);
    if (row.lost_at === null) {
      // Requests it had open there can't be answered from here any more.
      this.deps.mirror.release(`child:${row.id}`);
      try {
        // One transaction: a question about lost contact gives way to the one about its
        // pairing, which opens first, on its row, so the row counts it once. A failed write
        // leaves it as it was (`lost_at` unset), and the next poll does it all again.
        this.deps.store.atomic(() => {
          this.close(row, { state: "expired" });
          this.open(row, lostRequest(row, name));
          this.deps.ledger.markLost(row.id, this.deps.now());
          this.launchRow(row, name, { state: "needs_you", interactions: 1 }, "needs_you");
        });
      } catch (error) {
        this.deps.log("Lost child not shown to the person yet", {
          id: row.id,
          error: String(error),
        });
        return;
      }
      this.deps.emit([row.id]);
      return;
    }
    this.ask(row, name);
  }
  /**
   * A settled child's pairing is gone before a check after its 24 h mark, or while its stop is
   * unconfirmed: the re-check can't watch it and no cancel can reach it, so its parent asks the
   * person. It stays settled with its result, still unconfirmed if it was; called on every poll,
   * so an approval that closed opens again.
   */
  keepSettled(row: ChildRow): void {
    const name = this.deps.label(row.machine);
    if (row.lost_at === null) this.deps.ledger.markLost(row.id, this.deps.now());
    this.ask(row, name, settledRequest(row, name));
    this.deps.emit([row.id]);
  }
  /** A settled lost child's pairing is back: the approval closes and the re-check reads it. */
  foundSettled(row: ChildRow): void {
    this.deps.store.atomic(() => {
      this.close(row, { state: "expired" });
      this.deps.ledger.clearLost(row.id);
    });
    this.deps.emit([row.id]);
  }
  /** Its pairing is back: the approval closes and the poll reads it again. */
  found(row: ChildRow): void {
    const name = this.deps.label(row.machine);
    this.deps.store.atomic(() => {
      this.close(row, { state: "expired" });
      this.deps.ledger.clearLost(row.id);
      this.launchRow(row, name, { state: "working", agents: 1 }, "working");
    });
    this.deps.emit([row.id]);
  }
  /**
   * The child's machine stopped answering for a lease (ADR 0153): it is lost contact, which is
   * not knowing, so its parent keeps holding it and asks the person. Called when its lease runs
   * out and on every poll after, so a question that closed (its parent's session ended) opens
   * again and is never opened twice. The question and the child's row (its hold kept, or taken
   * back from an older build that let it go) are written in one transaction: an open question
   * always means the row was written, and a failed write leaves neither, for the next poll.
   */
  silent(row: ChildRow, since: number): void {
    if (this.pending(row)) return;
    try {
      if (this.openSilent(row, since)) this.deps.emit([row.id]);
    } catch (error) {
      this.deps.log("Lost contact not shown to the person yet", {
        id: row.id,
        error: String(error),
      });
    }
  }
  /**
   * Opens the question about a child that lost contact, with its row, in the caller's
   * transaction if there is one; false when its parent is gone. Throws when a write fails, so a
   * caller marking it silent in the same transaction rolls that back too.
   */
  openSilent(row: ChildRow, since: number): boolean {
    const name = this.deps.label(row.machine);
    const request = silentRequest(row, name, since, this.deps.now());
    return this.deps.store.atomic(() => {
      // The question opens first, on its row, so the row counts it once.
      if (!this.open(row, request)) return false;
      this.launchRow(row, name, { state: "needs_you", interactions: 1 }, "needs_you", null, "lost");
      return true;
    });
  }
  /**
   * Closes every open question its child's state no longer explains (`questionFate`): back in
   * contact, being stopped, settled, stopped tracking. Run on every poll from the stored rows, so
   * a change whose closing of the question failed is finished later, whatever the path.
   */
  reconcile(): void {
    for (const row of this.deps.ledger.asked()) {
      if (questionFate(questionFacts(row)) === "keep") continue;
      try {
        this.deps.store.atomic(() => {
          this.close(row, { state: "expired" });
          this.deps.ledger.clearAsk(row.id);
        });
        this.deps.emit([row.id]);
      } catch (error) {
        this.deps.log("Machine child question not closed yet", {
          id: row.id,
          error: String(error),
        });
      }
    }
  }
  /** Whether a question is open that its child's state no longer explains. */
  stale(): boolean {
    return this.deps.ledger.asked().some((row) => questionFate(questionFacts(row)) === "close");
  }
  /** Its machine answered again, or a stop began: the question about lost contact closes. */
  heard(row: ChildRow): void {
    if (row.lost_at !== null || !row.lost_ask) return;
    this.close(row, { state: "expired" });
    this.deps.ledger.clearLost(row.id);
  }
  /** The person's answer to a lost child's approval; undefined for any other interaction. */
  resolve(command: Command): CommandResult | undefined {
    if (command.payload.type !== "interaction.resolve") return undefined;
    const row = this.deps.ledger.byLostAsk(command.payload.interactionId);
    if (!row) return undefined;
    const { resolution } = command.payload;
    if (resolution.kind !== "approval" || resolution.optionId !== STOP_TRACKING)
      return { commandId: command.id, ok: false, error: "invalid_resolution" };
    // A settled child the person stops watching keeps its result; nothing new is owed. One
    // whose stop was never confirmed stays unconfirmed, and its cancel stops for good.
    if (
      row.settled === 1 &&
      row.lost_at !== null &&
      (row.settled_at !== null || row.stopped_unconfirmed === 1)
    ) {
      this.deps.store.atomic(() => {
        this.close(row, { state: "resolved", resolution, resolvedBy: command.deviceId });
        this.endWatch(row);
      });
      this.deps.emit([row.id]);
      return { commandId: command.id, ok: true, threadId: row.parent_thread };
    }
    // Its child is no longer one to ask about (it settled, or is back in contact): the question
    // closes, and there is nothing else to do.
    if (questionFate(questionFacts(row)) === "close") {
      this.deps.store.atomic(() => {
        this.close(row, { state: "resolved", resolution, resolvedBy: command.deviceId });
        this.deps.ledger.clearAsk(row.id);
      });
      this.deps.emit([row.id]);
      return { commandId: command.id, ok: true, threadId: row.parent_thread };
    }
    const silent = row.lost_at === null && row.silent_since !== null;
    if (row.settled !== 0 || (row.lost_at === null && !silent))
      return { commandId: command.id, ok: false, error: "already_resolved" };
    const name = this.deps.label(row.machine);
    const now = this.deps.now();
    const view = silent ? silentAbandonedView(row, name, now) : abandonedView(row, name, now);
    this.deps.store.atomic(() => {
      this.close(row, { state: "resolved", resolution, resolvedBy: command.deviceId });
      // Stopped tracking for good, as a child whose pairing went: no late report revives it.
      if (silent) this.deps.ledger.markLost(row.id, now);
      this.deps.ledger.markAbandoned(row.id, JSON.stringify(view));
      this.launchRow(row, name, view.status, view.state, {
        threadId: row.id,
        outcome: "cancelled",
        result: view.result ?? "",
        truncated: false,
        before: null,
      });
      this.deps.results.queueResult(row, view);
    });
    this.deps.emit([row.id]);
    return { commandId: command.id, ok: true, threadId: row.parent_thread };
  }
  /**
   * A settled lost child is no longer watched; a stop never confirmed can't be any more, and
   * says so.
   */
  endWatch(row: ChildRow): void {
    if (row.stopped_unconfirmed === 1) {
      const view = unconfirmableView(
        row,
        this.deps.label(row.machine),
        "unpaired",
        this.deps.now(),
      );
      this.deps.ledger.markStopUnconfirmable(row.id, JSON.stringify(view));
    }
    this.deps.ledger.endWatch(row.id);
  }
  /** Whether the parent's approval about the child is open. */
  private pending(row: ChildRow): boolean {
    return (
      row.lost_ask !== null &&
      this.deps.store.getInteraction(InteractionId.parse(row.lost_ask))?.state === "pending"
    );
  }
  /** Opens the parent's approval about the child, unless one is open already. */
  private ask(row: ChildRow, name: string, request = lostRequest(row, name)): void {
    if (this.pending(row)) return;
    try {
      if (this.deps.store.atomic(() => this.open(row, request))) this.deps.emit([row.id]);
    } catch (error) {
      this.deps.log("Lost child not shown to the person yet", { id: row.id, error: String(error) });
    }
  }
  /**
   * Opens the parent's approval about the child, in the caller's transaction; false when its
   * parent is gone. Throws when the write fails.
   */
  private open(row: ChildRow, request: InteractionRequest): boolean {
    const engine = this.deps.engine(row.parent_thread);
    if (!engine || parentGone(this.deps.store, row.parent_thread)) return false;
    const key = `machine-lost:${row.id}:${this.deps.now()}:${++this.asks}`;
    const ask = engine.openHostApproval(
      row.parent_thread,
      key,
      request,
      // Names the child, so its row can offer the same answer.
      [{ type: "ace.machine.lost", data: { machine: row.machine, threadId: row.id } }],
      childAgentKey(row.id),
    );
    this.deps.ledger.setLostAsk(row.id, key, ask);
    return true;
  }
  private close(row: ChildRow, result: Parameters<Engine["resolveHostApproval"]>[2]): void {
    if (!row.lost_key || !row.lost_ask) return;
    if (this.deps.store.getInteraction(InteractionId.parse(row.lost_ask))?.state !== "pending")
      return;
    this.deps
      .engine(row.parent_thread)
      ?.resolveHostApproval(row.parent_thread, row.lost_key, result);
  }
  /**
   * The child's row in its parent, with `status`; an outcome ends the parent's hold on it. A
   * child that lost contact keeps (or, held by an older build that let it go, takes again) its
   * hold: not knowing whether it ended is never ended.
   */
  private launchRow(
    row: ChildRow,
    name: string,
    status: MachineThreadView["status"],
    state: MachineThreadView["state"],
    outcome: Parameters<Engine["machineChild"]>[0]["outcome"] = null,
    contact?: "lost",
  ): void {
    if (parentGone(this.deps.store, row.parent_thread)) return;
    this.deps.engine(row.parent_thread)?.machineChild(
      {
        id: row.id,
        parentId: row.parent_thread,
        parentAgentId: row.parent_agent,
        machine: row.machine,
        name,
        hostId: this.deps.host?.(row.machine),
        provider: row.provider,
        model: row.model ?? undefined,
        role: row.role,
        title: savedView(row)?.title || row.role,
        status,
        state,
        outcome,
        contact,
      },
      outcome ? "end" : contact ? "start" : undefined,
    );
  }
}
