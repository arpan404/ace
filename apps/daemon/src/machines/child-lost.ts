import {
  InteractionId,
  type Command,
  type CommandResult,
  type InteractionRequest,
  type MachineThreadView,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import { savedView, type ChildLedger, type ChildRow } from "./child-ledger.ts";
import type { ChildResults } from "./child-results.ts";
import { abandonedView, lostLine } from "./child-views.ts";
import type { RequestMirror } from "./mirror.ts";

/** The answer that stops tracking a lost child. */
export const STOP_TRACKING = "stop-tracking";

export interface LostChildrenDeps {
  store: Store;
  ledger: ChildLedger;
  engine(): Engine | undefined;
  now(): number;
  label(machine: string): string;
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
      this.deps.store.atomic(() => {
        this.deps.ledger.markLost(row.id, this.deps.now());
        this.launchRow(row, name, { state: "needs_you", interactions: 1 });
      });
      // Requests it had open there can't be answered from here any more.
      this.deps.mirror.release(`child:${row.id}`);
      this.deps.emit([row.id]);
    }
    this.ask(row, name);
  }
  /** Its pairing is back: the approval closes and the poll reads it again. */
  found(row: ChildRow): void {
    const name = this.deps.label(row.machine);
    this.deps.store.atomic(() => {
      this.close(row, { state: "expired" });
      this.deps.ledger.clearLost(row.id);
      this.launchRow(row, name, { state: "working", agents: 1 });
    });
    this.deps.emit([row.id]);
  }
  /** The person's answer to a lost child's approval; undefined for any other interaction. */
  resolve(command: Command): CommandResult | undefined {
    if (command.payload.type !== "interaction.resolve") return undefined;
    const row = this.deps.ledger.byLostAsk(command.payload.interactionId);
    if (!row) return undefined;
    const { resolution } = command.payload;
    if (resolution.kind !== "approval" || resolution.optionId !== STOP_TRACKING)
      return { commandId: command.id, ok: false, error: "invalid_resolution" };
    if (row.settled !== 0 || row.lost_at === null)
      return { commandId: command.id, ok: false, error: "already_resolved" };
    const name = this.deps.label(row.machine);
    const view = abandonedView(row, name, this.deps.now());
    this.deps.store.atomic(() => {
      this.close(row, { state: "resolved", resolution, resolvedBy: command.deviceId });
      this.deps.ledger.markAbandoned(row.id, JSON.stringify(view));
      this.launchRow(row, name, view.status, {
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
  /** Opens the parent's approval about the child, unless one is open already. */
  private ask(row: ChildRow, name: string): void {
    const { store } = this.deps;
    if (
      row.lost_ask &&
      store.getInteraction(InteractionId.parse(row.lost_ask))?.state === "pending"
    )
      return;
    const parent = store.getThread(row.parent_thread);
    const engine = this.deps.engine();
    if (!engine || !parent || parent.deletedAt !== undefined) return;
    const key = `machine-lost:${row.id}:${this.deps.now()}:${++this.asks}`;
    try {
      store.atomic(() => {
        const ask = engine.openHostApproval(
          row.parent_thread,
          key,
          lostRequest(row, name),
          // Names the child, so its row can offer the same answer.
          [{ type: "ace.machine.lost", data: { machine: row.machine, threadId: row.id } }],
        );
        this.deps.ledger.setLostAsk(row.id, key, ask);
      });
      this.deps.emit([row.id]);
    } catch (error) {
      this.deps.log("Lost child not shown to the person yet", { id: row.id, error: String(error) });
    }
  }
  private close(row: ChildRow, result: Parameters<Engine["resolveHostApproval"]>[2]): void {
    if (!row.lost_key || !row.lost_ask) return;
    if (this.deps.store.getInteraction(InteractionId.parse(row.lost_ask))?.state !== "pending")
      return;
    this.deps.engine()?.resolveHostApproval(row.parent_thread, row.lost_key, result);
  }
  /** The child's row in its parent, with `status`; an outcome ends the parent's hold on it. */
  private launchRow(
    row: ChildRow,
    name: string,
    status: MachineThreadView["status"],
    outcome: Parameters<Engine["machineChild"]>[0]["outcome"] = null,
  ): void {
    this.deps.engine()?.machineChild(
      {
        id: row.id,
        parentId: row.parent_thread,
        parentAgentId: row.parent_agent,
        machine: row.machine,
        name,
        provider: row.provider,
        model: row.model ?? undefined,
        role: row.role,
        title: savedView(row)?.title || row.role,
        status,
        outcome,
      },
      outcome ? "end" : undefined,
    );
  }
}
