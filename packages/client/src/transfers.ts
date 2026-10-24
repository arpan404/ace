import type { z } from "zod";
import type { CommandResult, Transfer, TransferCommands } from "@ace/protocol";
import type { ProjectsClient } from "./projects-types.ts";
import { ClientError, type RequestOptions } from "./types.ts";

/*
 * Carrying a project, or a thread with its project, to another machine (ADR 0099). The two
 * commands take the durable command path; progress arrives as `transfer.progress` pushes, and
 * `list` answers what is running or finished lately, so a store can catch up after a reconnect.
 */

type Command = z.output<(typeof TransferCommands)[number]>;
/** Ids are the protocol's branded ones; `includeChanges` defaults to true. */
type Input<T extends Command["type"]> = Omit<
  Extract<Command, { type: T }>,
  "type" | "includeChanges"
> & { includeChanges?: boolean | undefined };

/** The daemon refused a list or cancel, with its code and a message a person acts on. */
export class TransferError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TransferError";
    this.code = code;
  }
}

export interface TransfersApi {
  /** "Open on <machine>": the project there, on the same branch. */
  openOn(
    input: Input<"workspace.transfer">,
    options?: RequestOptions,
    commandId?: string,
  ): Promise<CommandResult>;
  /** "Continue on <machine>": the project there, then a new thread from this one's history. */
  continueOn(
    input: Input<"thread.continueOn">,
    options?: RequestOptions,
    commandId?: string,
  ): Promise<CommandResult>;
  /** Running transfers and those finished in the last 24 hours, newest first. */
  list(options?: RequestOptions): Promise<Transfer[]>;
  cancel(transferId: string, options?: RequestOptions): Promise<Transfer>;
  onProgress(listener: (transfer: Transfer) => void): () => void;
}

export function transfersApi(client: ProjectsClient): TransfersApi {
  const request = async (
    operation: { op: "list" } | { op: "cancel"; transferId: string },
    options?: RequestOptions,
  ) => {
    const reply = await client.request({ type: "transfers.request", operation }, options);
    if (reply.result.kind === "error")
      throw new TransferError(reply.result.code, reply.result.message);
    return reply.result;
  };
  return {
    openOn: (input, options, id) =>
      client.command(
        { type: "workspace.transfer", ...input, includeChanges: input.includeChanges ?? true },
        options,
        id,
      ),
    continueOn: (input, options, id) =>
      client.command(
        { type: "thread.continueOn", ...input, includeChanges: input.includeChanges ?? true },
        options,
        id,
      ),
    list: async (options) => {
      const result = await request({ op: "list" }, options);
      return result.kind === "list" ? result.transfers : [];
    },
    cancel: async (transferId, options) => {
      const result = await request({ op: "cancel", transferId }, options);
      if (result.kind !== "cancelled") throw new ClientError("protocol", "Unexpected reply");
      return result.transfer;
    },
    onProgress: (listener) =>
      client.onMessage((message) => {
        if (message.type === "transfer.progress") listener(message.transfer);
      }),
  };
}

const finished = new Set<Transfer["phase"]>(["completed", "failed", "cancelled"]);

/** Whether a transfer is still moving (cancel applies only before `starting`). */
export function transferRunning(transfer: Transfer): boolean {
  return !finished.has(transfer.phase);
}

/**
 * Every transfer one machine reported, keyed by id: pushes and list results merge, and an
 * older report never replaces a newer one, so a list answered before a push can't undo it.
 * Pure state with listeners; whoever owns the client feeds it.
 */
export class TransferStore {
  private byId = new Map<string, Transfer>();
  private snapshot: readonly Transfer[] = [];
  private listeners = new Set<() => void>();

  /** Newest first. The same array until something changes. */
  all = (): readonly Transfer[] => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  apply(transfer: Transfer): void {
    if (this.merge(transfer)) this.publish();
  }
  /** A `list` result: merged, never dropping a newer push. */
  seed(transfers: readonly Transfer[]): void {
    let changed = false;
    for (const transfer of transfers) changed = this.merge(transfer) || changed;
    if (changed) this.publish();
  }
  /** The latest transfer of this thread. */
  forThread(threadId: string): Transfer | undefined {
    return this.snapshot.find((each) => each.kind === "thread" && each.threadId === threadId);
  }
  /** The latest project transfer ("Open on") of this project. */
  forProject(workspaceId: string): Transfer | undefined {
    return this.snapshot.find(
      (each) => each.kind === "project" && each.workspaceId === workspaceId,
    );
  }
  private merge(transfer: Transfer): boolean {
    const known = this.byId.get(transfer.transferId);
    if (known && known.updatedAt > transfer.updatedAt) return false;
    if (known && known.updatedAt === transfer.updatedAt && known.phase === transfer.phase)
      if (known.sentBytes === transfer.sentBytes) return false;
    this.byId.set(transfer.transferId, transfer);
    return true;
  }
  private publish(): void {
    this.snapshot = [...this.byId.values()].toSorted((a, b) => b.startedAt - a.startedAt);
    for (const listener of this.listeners) listener();
  }
}
