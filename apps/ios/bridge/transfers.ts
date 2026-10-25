import {
  continueBlocked,
  followTransfers,
  TransferError,
  TransferStore,
  transferCancellable,
  transfersApi,
  type ClientCore,
  type ThreadSource,
  type TransfersApi,
} from "@ace/client";
import { HostId, ThreadId, WorkspaceId, type CommandResult } from "@ace/protocol";
import {
  placementOf,
  threadTransferState,
  type Placement,
  type Refusal,
  type TransferMachine,
} from "@ace/ui-core/transfers";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { readLinks } from "./transfer-links.ts";
import {
  lineKey,
  threadLine,
  type HeldRefusal,
  type LineAct,
  type Subject,
} from "./transfer-lines.ts";
import { settle, sheetView, type Step } from "./transfer-sheet.ts";

/*
 * Continue on… and Open on… for this runtime's machine (ADR 0101). The SDK's transfer store
 * follows the machine's transfers (pushes, and a fresh list on every ready connection); this
 * reads its fleet links, starts and cancels transfers, walks the sheet's steps and says each
 * line. Swift draws `transfers.machines`, `transfers.sheet` and `transfers.thread`.
 */

const text = z.string().min(1).max(256);
const SubjectInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1).max(128), title: z.string() }),
  z.object({ kind: z.literal("project"), workspaceId: z.string().min(1).max(128), name: text }),
]);
export const TransferAction = z.discriminatedUnion("kind", [
  /** Read the linked machines and the "Bring ignored files" default again. */
  z.object({ kind: z.literal("machines") }),
  /** `machine`: open straight on its options (Try again without known options). */
  z.object({
    kind: z.literal("open"),
    subject: SubjectInput,
    machine: z.object({ hostId: text, name: text }).optional(),
  }),
  z.object({ kind: z.literal("choose"), hostId: text }),
  z.object({ kind: z.literal("back") }),
  z.object({
    kind: z.literal("send"),
    includeChanges: z.boolean(),
    includeIgnored: z.boolean(),
    parent: z.string().min(1).max(4096).optional(),
  }),
  /** Try again on the sheet's status step. */
  z.object({ kind: z.literal("retry") }),
  z.object({ kind: z.literal("close") }),
  /** A text button on a line: the sheet's, or the open thread's above its composer. */
  z.object({
    kind: z.literal("line"),
    transferId: z.string().min(1).max(128),
    act: z.enum(["cancel", "retry", "dismiss"]),
  }),
]);
export type TransferAction = z.infer<typeof TransferAction>;

/** What transfers need of the SDK client. */
export type TransfersOwner = Pick<
  ClientCore,
  "command" | "request" | "onMessage" | "connectionState"
>;

type Started = { ok: true; commandId: string } | ({ ok: false } & Refusal);

/** Only the daemon's transfer refusals carry words meant for a person; others, their code. */
const refusalOf = (error: unknown): Refusal => {
  if (error instanceof TransferError) return { code: error.code, detail: error.message };
  if (typeof error !== "object" || error === null || !("code" in error)) return { code: undefined };
  return { code: String(error.code) };
};

interface OpenThread {
  threadId: string;
  epoch: number;
  store: ThreadSource;
}

export class NativeTransfers {
  readonly store = new TransferStore();
  #api: TransfersApi;
  #owner: TransfersOwner;
  #sink: PatchSink;
  #links: { state: "loading" | "ready" | "failed"; machines: TransferMachine[] } = {
    state: "loading",
    machines: [],
  };
  #ignoredByDefault = true;
  #reading = false;
  #sheet: { subject: Subject; step: Step } | undefined;
  #thread: { open: OpenThread; stop: () => void } | undefined;
  /** Why Cancel or Try again was refused, per transfer as it was then. */
  #refused = new Map<string, HeldRefusal>();
  /** The button pressed on each transfer, until it answers. */
  #busy = new Map<string, { key: string; act: LineAct }>();
  #stop: () => void;
  constructor(owner: TransfersOwner, sink: PatchSink) {
    this.#owner = owner;
    this.#sink = sink;
    this.#api = transfersApi(owner);
    const stopFollow = followTransfers(
      { transfers: this.#api, connectionState: () => owner.connectionState() },
      this.store,
    );
    const stopStore = this.store.subscribe(() => this.#changed());
    const connection = owner.connectionState();
    const stopConnection = connection.subscribe(() => {
      if (connection.getSnapshot() === "ready") void this.#readMachines();
    });
    if (connection.getSnapshot() === "ready") void this.#readMachines();
    this.#stop = () => {
      stopFollow();
      stopStore();
      stopConnection();
      this.#thread?.stop();
    };
    this.#putMachines();
  }
  dispose(): void {
    this.#stop();
  }
  /** The thread open on the phone, whose line shows above its composer; undefined on leaving. */
  follow(open: OpenThread | undefined): void {
    this.#thread?.stop();
    this.#thread = undefined;
    if (open) {
      const selection = open.store.select(["thread", "unconfirmed"], (reader) => ({
        thread: reader.thread,
        unconfirmed: reader.unconfirmed === true,
      }));
      const stop = selection.subscribe(() => this.#putThread());
      this.#thread = { open, stop };
    }
    this.#putThread();
  }
  handle(action: TransferAction): void {
    switch (action.kind) {
      case "machines":
        void this.#readMachines();
        return;
      case "open": {
        const latest = this.#latest(action.subject);
        const step: Step = action.machine
          ? { kind: "options", machine: action.machine }
          : settle({ kind: "checking" }, this.store.seeded(), latest);
        this.#sheet = { subject: action.subject, step };
        void this.#readMachines();
        break;
      }
      case "choose": {
        const machine = this.#links.machines.find(
          (each) => each.hostId === action.hostId && !each.reason,
        );
        if (this.#sheet?.step.kind === "machines" && machine)
          this.#sheet.step = { kind: "options", machine };
        break;
      }
      case "back":
        if (this.#sheet?.step.kind === "options") this.#sheet.step = { kind: "machines" };
        break;
      case "send": {
        const step = this.#sheet?.step;
        if (step?.kind !== "options") return;
        this.#send(step.machine, {
          hostId: step.machine.hostId,
          ...(action.parent ? { parent: action.parent } : {}),
          includeChanges: action.includeChanges,
          includeIgnored: action.includeIgnored,
        });
        break;
      }
      case "retry": {
        const step = this.#sheet?.step;
        if (step?.kind !== "status") return;
        const transfer = this.#started(step);
        // The choices made here, else the ones the transfer's record echoes, else ask again.
        const placement = step.placement ?? (transfer ? placementOf(transfer) : undefined);
        if (placement) this.#send(step.machine, placement);
        else if (this.#sheet) this.#sheet.step = { kind: "options", machine: step.machine };
        break;
      }
      case "close":
        this.#sheet = undefined;
        break;
      case "line":
        this.#line(action.transferId, action.act);
        return;
    }
    this.#putSheet();
  }
  #latest(subject: Subject) {
    return subject.kind === "thread"
      ? this.store.forThread(subject.threadId)
      : this.store.forProject(subject.workspaceId);
  }
  #started(step: Extract<Step, { kind: "status" }>) {
    const started = step.started;
    if (!started || !("commandId" in started)) return undefined;
    return this.store.all().find((each) => each.commandId === started.commandId);
  }
  #send(machine: { hostId: string; name: string }, placement: Placement): void {
    const sheet = this.#sheet;
    if (!sheet) return;
    const step: Step = { kind: "status", machine, placement, started: undefined };
    sheet.step = step;
    void this.#start(sheet.subject, placement).then((started) => {
      // Only the send still on screen takes its answer.
      if (this.#sheet?.step !== step) return;
      this.#sheet.step = {
        ...step,
        started: started.ok ? { commandId: started.commandId } : { refused: started },
      };
      this.#putSheet();
    });
  }
  async #start(subject: Subject, placement: Placement): Promise<Started> {
    let result: CommandResult;
    try {
      const place = {
        hostId: HostId.parse(placement.hostId),
        ...(placement.parent ? { parent: placement.parent } : {}),
        includeChanges: placement.includeChanges,
        ...(placement.includeIgnored === undefined
          ? {}
          : { includeIgnored: placement.includeIgnored }),
      };
      result =
        subject.kind === "thread"
          ? await this.#api.continueOn({ threadId: ThreadId.parse(subject.threadId), ...place })
          : await this.#api.openOn({
              workspaceId: WorkspaceId.parse(subject.workspaceId),
              ...place,
            });
    } catch (error) {
      return { ok: false, ...refusalOf(error) };
    }
    return result.ok
      ? { ok: true, commandId: result.commandId }
      : {
          ok: false,
          code: result.code ?? result.error,
          ...(result.detail ? { detail: result.detail } : {}),
        };
  }
  /** Cancel, Try again or Dismiss on a line, wherever it shows. */
  #line(transferId: string, act: Exclude<LineAct, "open">): void {
    const transfer = this.store.all().find((each) => each.transferId === transferId);
    if (!transfer) return;
    if (act === "dismiss") {
      this.store.dismiss(transferId);
      return;
    }
    const key = lineKey(transfer);
    if (this.#busy.get(transferId)?.key === key) return;
    let pending: Promise<Refusal | undefined>;
    if (act === "cancel") {
      if (!transferCancellable(transfer)) return;
      pending = this.#api.cancel(transferId).then(
        () => undefined,
        (error: unknown) => refusalOf(error),
      );
    } else {
      const placement = placementOf(transfer);
      const subject = this.#subjectOf(transfer);
      if (!placement || !subject) {
        // A daemon that didn't echo the choices: ask for them once more, on that machine.
        if (subject) this.handle({ kind: "open", subject, machine: transfer.target });
        return;
      }
      if (this.#sheet) {
        this.#send(transfer.target, placement);
        this.#putSheet();
        return;
      }
      pending = this.#start(subject, placement).then((started) =>
        started.ok ? undefined : started,
      );
    }
    this.#busy.set(transferId, { key, act });
    this.#changed();
    void pending.then((refusal) => {
      this.#busy.delete(transferId);
      if (refusal) this.#refused.set(transferId, { key, refusal });
      else this.#refused.delete(transferId);
      this.#changed();
    });
  }
  #subjectOf(transfer: { kind: string; threadId?: string | undefined; workspaceId: string }) {
    if (this.#sheet) return this.#sheet.subject;
    if (transfer.kind === "thread" && transfer.threadId) {
      const title =
        this.#thread?.open.threadId === transfer.threadId
          ? (this.#thread.open.store.thread?.title ?? "")
          : "";
      return { kind: "thread" as const, threadId: transfer.threadId, title };
    }
    return undefined;
  }
  async #readMachines(): Promise<void> {
    if (this.#reading) return;
    this.#reading = true;
    try {
      const read = await readLinks(this.#owner);
      this.#links = read.machines
        ? { state: "ready", machines: read.machines }
        : { ...this.#links, state: this.#links.state === "ready" ? "ready" : "failed" };
      if (read.ignoredByDefault !== undefined) this.#ignoredByDefault = read.ignoredByDefault;
    } finally {
      this.#reading = false;
    }
    this.#putMachines();
    this.#putSheet();
  }
  #changed(): void {
    const sheet = this.#sheet;
    if (sheet) sheet.step = settle(sheet.step, this.store.seeded(), this.#latest(sheet.subject));
    this.#putSheet();
    this.#putThread();
  }
  #lineOptions(transferId: string | undefined) {
    if (!transferId) return {};
    const transfer = this.store.all().find((each) => each.transferId === transferId);
    const busy = this.#busy.get(transferId);
    return {
      refused: this.#refused.get(transferId),
      busy: transfer && busy?.key === lineKey(transfer) ? busy.act : undefined,
    };
  }
  #putMachines(): void {
    this.#sink.put("transfers:machines", () => ({
      type: "transfers.machines",
      state: this.#links.state,
      machines: this.#links.machines.map((each) => ({ ...each, reason: each.reason ?? null })),
      ignoredByDefault: this.#ignoredByDefault,
    }));
  }
  #putSheet(): void {
    this.#sink.put("transfers:sheet", () => {
      const sheet = this.#sheet;
      if (!sheet) return { type: "transfers.sheet", sheet: null };
      const transfer = sheet.step.kind === "status" ? this.#started(sheet.step) : undefined;
      return {
        type: "transfers.sheet",
        sheet: sheetView(sheet.subject, sheet.step, {
          links: this.#links,
          ignoredByDefault: this.#ignoredByDefault,
          transfer,
          lineOptions: this.#lineOptions(transfer?.transferId),
        }),
      };
    });
  }
  #putThread(): void {
    this.#sink.put("transfers:thread", () => {
      const open = this.#thread?.open;
      if (!open) return { type: "transfers.thread", thread: null };
      const thread = open.store.thread;
      const transfer = this.store.forThread(open.threadId);
      const state = threadTransferState(
        transfer,
        thread?.details,
        transfer ? this.store.dismissed(transfer.transferId) : false,
      );
      // A copy the daemon hasn't confirmed may be working again: wait until it says.
      const settled =
        thread !== undefined &&
        open.store.unconfirmed !== true &&
        !continueBlocked(thread.status.state);
      return {
        type: "transfers.thread",
        thread: {
          threadId: open.threadId,
          epoch: open.epoch,
          canContinue: settled,
          line: threadLine(state, this.#lineOptions(transfer?.transferId)),
        },
      };
    });
  }
}
