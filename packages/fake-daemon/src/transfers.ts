import type { z } from "zod";
import {
  ProviderKind,
  ThreadContinuedOn,
  Transfer,
  type ClientMessage,
  type Command,
  type CommandResult,
  type FleetLink,
  type ServerMessage,
  type TransfersResult,
} from "@ace/protocol";

/*
 * Transfers in memory (ADR 0099): this machine "sends" a project, or a thread with its project,
 * to another fake machine it has a fleet link to, stepping through the phases a real transfer
 * reports and pushing `transfer.progress` on each. When it completes the project (and the new
 * thread) exist on the other fake, so the app can open them there.
 */

type TransferCommand = Extract<
  Command["payload"],
  { type: "workspace.transfer" | "thread.continueOn" }
>;

/** What a sending machine needs of the machine it sends to. */
export interface TransferPeer {
  hostId: string;
  name: string;
  /** Lands the project there and returns where; an existing one with the same name is reused. */
  receiveProject(input: { name: string; parent?: string | undefined }): {
    workspaceId: string;
    path: string;
  };
  /** Starts the continued thread there, with where it came from. */
  receiveThread(input: {
    workspaceId: string;
    title: string;
    provider: string;
    from: ThreadContinuedOn;
  }): string;
}

export interface TransferPorts {
  clock(): number;
  hostId(): string;
  /** This machine's name, as the other one records where work came from. */
  name(): string;
  broadcast(message: ServerMessage): void;
  links(): readonly FleetLink[];
  peer(hostId: string): TransferPeer | undefined;
  project(id: string): { name: string } | undefined;
  thread(
    id: string,
  ): { workspaceId: string; title: string; provider: string; busy: boolean } | undefined;
  /** Records where the source thread went. */
  continued(threadId: string, on: ThreadContinuedOn): void;
  /** When each phase step runs (tests step transfers by hand). */
  schedule?(callback: () => void): void;
}

type Changes = Partial<z.input<typeof Transfer>>;

/** Bytes each fake transfer moves: enough for several "Sending" steps. */
const fakeSize = 1_200_000_000;
const steps = 4;

export class FakeTransfers {
  private ports: TransferPorts;
  private transfers = new Map<string, Transfer>();
  private cancels = new Set<string>();
  private next = 0;
  /** Codes `start` refuses with until cleared (tests stage a failure). */
  failWith: { code: string; message: string } | undefined;
  constructor(ports: TransferPorts) {
    this.ports = ports;
  }
  list(): Transfer[] {
    return [...this.transfers.values()].toSorted((a, b) => b.startedAt - a.startedAt);
  }
  /** Start one; the receipt says whether it started, progress follows as pushes. */
  start(command: Command & { payload: TransferCommand }): CommandResult {
    const payload = command.payload;
    const refuse = (error: string): CommandResult => ({ commandId: command.id, ok: false, error });
    const link = this.ports.links().find((entry) => entry.hostId === payload.hostId);
    if (!link) return refuse("machine_not_linked");
    if (link.access !== "operate" || link.projects === false) return refuse("machine_forbidden");
    const source =
      payload.type === "thread.continueOn"
        ? this.ports.thread(payload.threadId)
        : this.ports.project(payload.workspaceId) && { workspaceId: payload.workspaceId };
    if (!source)
      return refuse(
        payload.type === "thread.continueOn" ? "thread_not_found" : "workspace_not_found",
      );
    if ("busy" in source && source.busy) return refuse("thread_busy");
    const now = this.ports.clock();
    const transfer = Transfer.parse({
      transferId: `transfer-${++this.next}`,
      commandId: command.id,
      kind: payload.type === "thread.continueOn" ? "thread" : "project",
      workspaceId: source.workspaceId,
      ...(payload.type === "thread.continueOn" ? { threadId: payload.threadId } : {}),
      target: { hostId: payload.hostId, name: link.name },
      phase: "preparing",
      sentBytes: 0,
      startedAt: now,
      updatedAt: now,
    });
    this.publish(transfer);
    void this.run(transfer, payload);
    return { commandId: command.id, ok: true };
  }
  cancel(transferId: string): TransfersResult["result"] {
    const transfer = this.transfers.get(transferId);
    if (!transfer)
      return { kind: "error", code: "not_found", message: "That transfer isn't here any more." };
    if (["starting", "completed", "failed", "cancelled"].includes(transfer.phase))
      return {
        kind: "error",
        code: "too_late",
        message: "It already arrived; it can't be cancelled now.",
      };
    this.cancels.add(transferId);
    return { kind: "cancelled", transfer: this.update(transfer, { phase: "cancelled" }) };
  }
  /** False when the message isn't `transfers.request`. */
  handle(message: ClientMessage, push: (message: ServerMessage) => void): boolean {
    if (message.type !== "transfers.request") return false;
    const operation = message.operation;
    const result: TransfersResult["result"] =
      operation.op === "list"
        ? { kind: "list", transfers: this.list().slice(0, 100) }
        : this.cancel(operation.transferId);
    push({ type: "transfers.result", requestId: message.requestId, result });
    return true;
  }
  private async run(first: Transfer, payload: TransferCommand): Promise<void> {
    let transfer = first;
    const step = async (changes: Changes) => {
      await new Promise<void>((resolve) =>
        this.ports.schedule ? this.ports.schedule(resolve) : queueMicrotask(resolve),
      );
      if (this.cancels.has(transfer.transferId)) return false;
      transfer = this.update(transfer, changes);
      return true;
    };
    if (!(await step({ phase: "sending", method: "bundle", totalBytes: fakeSize }))) return;
    for (let index = 1; index <= steps; index++)
      if (!(await step({ sentBytes: Math.round((fakeSize * index) / steps) }))) return;
    if (!(await step({ phase: "importing" }))) return;
    const failure = this.failWith;
    const peer = this.ports.peer(payload.hostId);
    if (failure || !peer) {
      this.update(transfer, {
        phase: "failed",
        error: failure ?? {
          code: "machine_unreachable",
          message: `${transfer.target.name} didn't answer. Check that it's on and online.`,
        },
      });
      return;
    }
    const name = this.ports.project(transfer.workspaceId)?.name ?? "project";
    const landed = peer.receiveProject({ name, parent: payload.parent });
    if (payload.type === "workspace.transfer") {
      this.update(transfer, {
        phase: "completed",
        result: { workspaceId: landed.workspaceId, path: landed.path, branch: "main" },
      });
      return;
    }
    if (!(await step({ phase: "starting" }))) return;
    const thread = this.ports.thread(payload.threadId);
    const threadId = peer.receiveThread({
      workspaceId: landed.workspaceId,
      title: `${thread?.title ?? "Thread"} (from ${this.ports.name()})`,
      provider: thread?.provider ?? "claude",
      from: ThreadContinuedOn.parse({
        hostId: this.ports.hostId(),
        name: this.ports.name(),
        threadId: payload.threadId,
        at: this.ports.clock(),
      }),
    });
    this.ports.continued(
      payload.threadId,
      ThreadContinuedOn.parse({
        hostId: payload.hostId,
        name: transfer.target.name,
        threadId,
        at: this.ports.clock(),
      }),
    );
    this.update(transfer, {
      phase: "completed",
      result: { workspaceId: landed.workspaceId, path: landed.path, branch: "main", threadId },
    });
  }
  private update(transfer: Transfer, changes: Changes): Transfer {
    const next = Transfer.parse({ ...transfer, ...changes, updatedAt: this.ports.clock() });
    this.publish(next);
    return next;
  }
  private publish(transfer: Transfer): void {
    this.transfers.set(transfer.transferId, transfer);
    this.ports.broadcast({ type: "transfer.progress", transfer });
  }
}

/** What a fake machine offers as a transfer target, from its public surface. */
export function transferPeer(target: {
  hostId: string;
  displayName: string;
  projects: { receive(name: string, parent?: string): { workspaceId: string; path: string } };
  createThread(init: {
    id: string;
    workspaceId: string;
    title: string;
    provider: ProviderKind;
    details?: { continuedFrom: ThreadContinuedOn };
  }): void;
}): TransferPeer {
  let next = 0;
  return {
    hostId: target.hostId,
    name: target.displayName,
    receiveProject: (input) => target.projects.receive(input.name, input.parent),
    receiveThread: (input) => {
      const id = `continued-${input.from.threadId}-${++next}`;
      target.createThread({
        id,
        workspaceId: input.workspaceId,
        title: input.title,
        provider: ProviderKind.catch("claude").parse(input.provider),
        details: { continuedFrom: input.from },
      });
      return id;
    },
  };
}
