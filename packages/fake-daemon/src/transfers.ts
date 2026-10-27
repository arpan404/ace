import type { z } from "zod";
import { continueBlocked, transferCancellable } from "@ace/client";
import {
  FleetLink,
  ProviderKind,
  ThreadContinuedOn,
  Transfer,
  type ClientMessage,
  type Command,
  type CommandResult,
  type ServerMessage,
  type ThreadStatus,
  type TransferMethod,
  type TransfersResult,
} from "@ace/protocol";

/*
 * Transfers in memory (ADR 0101): this machine "sends" a project, or a thread with its project,
 * to another fake machine it has a fleet link to, stepping through the phases a real transfer
 * reports and pushing `transfer.progress` on each. It refuses as the real sender does, chooses
 * the method the same way (remote for a repository with an origin, bundle for one without,
 * archive for a plain folder) and lands on a project with the same origin when the other
 * machine has one. When it completes the project (and the new thread) exist on the other fake.
 */

type TransferCommand = Extract<
  Command["payload"],
  { type: "workspace.transfer" | "thread.continueOn" }
>;

/** What a sending machine needs of the machine it sends to. */
export interface TransferPeer {
  hostId: string;
  name: string;
  /** Whether a project there already has this origin (then nothing is cloned). */
  hasOrigin(origin: string): boolean;
  /** Lands the project there and returns where; one with the same origin is reused. */
  receiveProject(input: {
    name: string;
    parent?: string | undefined;
    origin?: string;
    git?: boolean;
  }): {
    workspaceId: string;
    path: string;
    reused: boolean;
  };
  /** Starts the continued thread there, with where it came from. */
  receiveThread(input: {
    workspaceId: string;
    title: string;
    provider: string;
    from: ThreadContinuedOn;
  }): string;
}

/** A fake machine as a transfer target, from its public surface. */
export interface PeerMachine {
  hostId: string;
  displayName: string;
  projects: {
    withOrigin(origin: string): unknown;
    receive(input: { name: string; parent?: string | undefined; origin?: string; git?: boolean }): {
      workspaceId: string;
      path: string;
      reused: boolean;
    };
  };
  createThread(init: {
    id: string;
    workspaceId: string;
    title: string;
    provider: ProviderKind;
    details?: { continuedFrom: ThreadContinuedOn };
  }): void;
}

export interface TransferPorts {
  clock(): number;
  hostId(): string;
  /** This machine's name, as the other one records where work came from. */
  name(): string;
  broadcast(message: ServerMessage): void;
  links(): readonly FleetLink[];
  /** Stores a link, as Settings › Fleet would. */
  seedLink(link: FleetLink): void;
  /** `remote.transferIgnoredFiles`, for a transfer that doesn't say. */
  ignoredByDefault(): boolean;
  project(id: string): { name: string; git: boolean; origin?: string } | undefined;
  thread(id: string):
    | {
        workspaceId: string;
        title: string;
        provider: string;
        status: ThreadStatus;
        details?:
          | { workspaceChange?: { state: string; uncertain?: boolean | undefined } | undefined }
          | undefined;
      }
    | undefined;
  /** Records where the source thread went. */
  continued(threadId: string, on: ThreadContinuedOn): void;
  /** When each phase step runs (tests step transfers by hand). */
  schedule?(callback: () => void): void;
}

type Changes = Partial<z.input<typeof Transfer>>;

/** Bytes a bundle or archive moves: enough for several "Sending" steps. */
const fakeSize = 1_200_000_000;
/** With origin there, only the commits it lacks travel. */
const remoteSize = 2_400_000;
/** What the fake's ignored files come to when they travel: counts only, never names. */
const fakeIgnored = { files: 3, bytes: 4096 };
/** How many of them a reused project already has (its own `.env`). */
const keptIgnored = 1;
const steps = 4;

export class FakeTransfers {
  private ports: TransferPorts;
  private transfers = new Map<string, Transfer>();
  private peers = new Map<string, TransferPeer>();
  private cancels = new Set<string>();
  private next = 0;
  /** The failure every transfer ends in at importing until cleared (tests stage one). */
  failWith: { code: string; message: string } | undefined;
  /** False: transfers don't echo their options, as daemons older than that field. */
  echoOptions = true;
  constructor(ports: TransferPorts) {
    this.ports = ports;
  }
  /**
   * Link this machine to `other` (as Settings › Fleet would) so it can send work there.
   * `link` overrides the stored link: `{ status: "offline" }`, `{ projects: false }`.
   */
  link(other: PeerMachine, link: Partial<FleetLink> = {}): void {
    this.ports.seedLink(
      FleetLink.parse({
        hostId: other.hostId,
        profile: other.hostId,
        name: other.displayName,
        origin: `https://${other.hostId}.local:5870/`,
        deviceId: `fleet-device-${other.hostId}`,
        status: "online",
        access: "operate",
        projects: true,
        ...link,
      }),
    );
    this.peers.set(other.hostId, transferPeer(other));
  }
  list(): Transfer[] {
    return [...this.transfers.values()].toSorted((a, b) => b.startedAt - a.startedAt);
  }
  /** Start one; the receipt says whether it started, progress follows as pushes. */
  start(command: Command & { payload: TransferCommand }): CommandResult {
    const payload = command.payload;
    const refuse = (code: string, detail: string): CommandResult => ({
      commandId: command.id,
      ok: false,
      error: code,
      code,
      detail,
    });
    const thread =
      payload.type === "thread.continueOn" ? this.ports.thread(payload.threadId) : undefined;
    if (payload.type === "thread.continueOn") {
      if (!thread) return refuse("thread_not_found", "That thread doesn't exist on this machine.");
      if (continueBlocked(thread.status.state))
        return refuse(
          "thread_busy",
          "This thread is still working, waiting on you or has open terminals. Let it finish or stop it first.",
        );
      const change = thread.details?.workspaceChange;
      if (change?.state === "preparing" || change?.uncertain)
        return refuse(
          "workspace_change_in_progress",
          "The thread's checkout is still being changed. Try again once that's done.",
        );
    }
    const workspaceId = thread?.workspaceId ?? ("workspaceId" in payload && payload.workspaceId);
    const project = workspaceId ? this.ports.project(workspaceId) : undefined;
    if (!workspaceId || !project)
      return refuse("workspace_not_found", "That project isn't on this machine.");
    const link = this.ports.links().find((entry) => entry.hostId === payload.hostId);
    if (!link)
      return refuse(
        "machine_not_linked",
        "This machine has no link to that one. Link them in Settings › Fleet.",
      );
    // The real sender asks the target's probe: offline can't answer, and a link without
    // Projects says it doesn't accept. A link refused only for agents still takes them.
    if (link.status === "offline")
      return refuse(
        "machine_offline",
        `${link.name} is offline or unreachable. Wake it and start ace there.`,
      );
    if (link.projects === false)
      return refuse(
        "machine_forbidden",
        `${link.name} doesn't let this machine move projects there. Link the machines again with Projects allowed.`,
      );
    const now = this.ports.clock();
    const includeIgnored = payload.includeIgnored ?? this.ports.ignoredByDefault();
    const transfer = Transfer.parse({
      transferId: `transfer-${++this.next}`,
      commandId: command.id,
      kind: payload.type === "thread.continueOn" ? "thread" : "project",
      workspaceId,
      ...(payload.type === "thread.continueOn" ? { threadId: payload.threadId } : {}),
      target: { hostId: payload.hostId, name: link.name },
      phase: "preparing",
      ...(this.echoOptions
        ? {
            options: {
              includeChanges: payload.includeChanges,
              includeIgnored,
              ...(payload.parent ? { parent: payload.parent } : {}),
            },
          }
        : {}),
      sentBytes: 0,
      startedAt: now,
      updatedAt: now,
    });
    this.publish(transfer);
    void this.run(transfer, payload);
    return {
      commandId: command.id,
      ok: true,
      ...(payload.type === "thread.continueOn" ? { threadId: payload.threadId } : {}),
    };
  }
  /**
   * Stops a transfer before its thread is being started, as the real sender does: once it has
   * completed that is `too_late`; otherwise past that point it answers with the transfer as is.
   */
  cancel(transferId: string): TransfersResult["result"] {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return { kind: "error", code: "not_found", message: "No such transfer." };
    if (transfer.phase === "completed")
      return {
        kind: "error",
        code: "too_late",
        message: `It already reached ${transfer.target.name}; the work is there now.`,
      };
    if (!transferCancellable(transfer)) return { kind: "cancelled", transfer };
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
    const source = this.ports.project(transfer.workspaceId);
    const peer = this.peers.get(payload.hostId);
    const origin = source?.git ? source.origin : undefined;
    const method: TransferMethod = !source?.git ? "archive" : origin ? "remote" : "bundle";
    // Ignored files go with the git methods only; an archive already holds the whole folder.
    const ignored =
      method !== "archive" && (payload.includeIgnored ?? this.ports.ignoredByDefault());
    const total = (method === "remote" ? remoteSize : fakeSize) + (ignored ? fakeIgnored.bytes : 0);
    // The target clones origin itself when it has no project with it yet.
    if (origin && peer && !peer.hasOrigin(origin))
      if (!(await step({ phase: "cloning", method }))) return;
    if (
      !(await step({
        phase: "sending",
        method,
        totalBytes: total,
        ...(ignored ? { ignoredFiles: fakeIgnored } : {}),
      }))
    )
      return;
    for (let index = 1; index <= steps; index++)
      if (!(await step({ sentBytes: Math.round((total * index) / steps) }))) return;
    if (!(await step({ phase: "importing" }))) return;
    const failure = this.failWith;
    if (failure || !peer) {
      this.update(transfer, {
        phase: "failed",
        error: failure ?? {
          code: "machine_offline",
          message: "The other machine stayed unreachable. Start the transfer again when it's back.",
        },
      });
      return;
    }
    // Nothing lands there while Cancel still applies: a thread's transfer reaches `starting`
    // (past cancelling) before its project is registered on the other machine.
    if (payload.type === "thread.continueOn" && !(await step({ phase: "starting" }))) return;
    const landed = peer.receiveProject({
      name: source?.name ?? "project",
      parent: payload.parent,
      ...(origin ? { origin } : {}),
      // A plain folder lands as a folder, with no branch, as the real daemon's archive does.
      git: method !== "archive",
    });
    const result = {
      workspaceId: landed.workspaceId,
      path: landed.path,
      ...(method === "archive" ? {} : { branch: "main" }),
      ...(ignored && landed.reused ? { ignoredSkipped: keptIgnored } : {}),
    };
    if (payload.type === "workspace.transfer") {
      this.update(transfer, { phase: "completed", result });
      return;
    }
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
    this.update(transfer, { phase: "completed", result: { ...result, threadId } });
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
function transferPeer(target: PeerMachine): TransferPeer {
  let next = 0;
  return {
    hostId: target.hostId,
    name: target.displayName,
    hasOrigin: (origin) => target.projects.withOrigin(origin) !== undefined,
    receiveProject: (input) => target.projects.receive(input),
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

/** The parts of a fake machine its transfers read from outside. */
export interface TransferHost {
  readonly hostId: string;
  readonly displayName: string;
  readonly services: {
    fleet: { links(): readonly FleetLink[]; seed(link: FleetLink): void };
    settings: { get(key: "remote.transferIgnoredFiles"): unknown };
  };
  readonly projects: { source(id: string): ReturnType<TransferPorts["project"]> };
}

/** A fake machine's transfers, wired to its fleet links, settings and projects. */
export function fakeTransfers(
  host: TransferHost,
  inner: Pick<TransferPorts, "clock" | "broadcast" | "thread" | "continued" | "schedule">,
): FakeTransfers {
  return new FakeTransfers({
    ...inner,
    hostId: () => host.hostId,
    name: () => host.displayName,
    links: () => host.services.fleet.links(),
    seedLink: (link) => host.services.fleet.seed(link),
    ignoredByDefault: () => host.services.settings.get("remote.transferIgnoredFiles") !== false,
    project: (id) => host.projects.source(id),
  });
}
