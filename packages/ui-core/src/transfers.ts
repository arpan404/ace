import { transferRunning } from "@ace/client";
import { fleetRefusal } from "./device-pairing.ts";
import type {
  DeviceScope,
  FleetLink,
  ThreadContinuedOn,
  ThreadDetails,
  ThreadStatus,
  Transfer,
} from "@ace/protocol";

/*
 * Work on another machine (ADR 0101) as every client shows it: which linked machines can take
 * work, what Try again repeats, and what a thread's line says about where its work went. Pure;
 * the web and the phones draw it.
 */

export { doneWords, refusalWords, runningWords, type Refusal } from "./transfer-words.ts";

/** A machine work can go to, or why it can't right now. */
export interface TransferMachine {
  hostId: string;
  name: string;
  /** The sending machine's device there: the link's credential, which Allow projects widens. */
  deviceId: string;
  /** Shown beside it, dimmed, instead of hiding it. */
  reason?: "Offline" | "Projects not allowed";
}

/**
 * The machines this one has fleet links to: each linked machine, offline or not-allowed ones
 * kept with the reason. A link that doesn't name its machine yet can't be sent to and is left
 * out. A link `refused` for agents still takes the person's transfers.
 */
export function transferMachines(links: readonly FleetLink[]): TransferMachine[] {
  return links.flatMap((link): TransferMachine[] => {
    if (!link.hostId) return [];
    const reason =
      link.status === "offline"
        ? "Offline"
        : // Older daemons don't say; then `operate` access is the best sign there is.
          (link.projects ?? link.access === "operate") === false
          ? "Projects not allowed"
          : undefined;
    return [
      {
        hostId: link.hostId,
        name: link.name,
        deviceId: link.deviceId,
        ...(reason ? { reason } : {}),
      },
    ];
  });
}

/**
 * What choosing a machine that doesn't take projects from this one offers (ADR 0101). A transfer
 * needs the link's device there to hold both `operate` and `projects`:
 * - `allow`: it holds operate, and this window may grant Projects there (an administrator holding
 *   Projects itself, since a device grants only what it holds, or that machine's own app).
 * - `viewOnly`: the link may only view there; adding Projects wouldn't let it take work, so the
 *   person links again from Settings › Fleet.
 * - `held`: it already holds both (what the picker read was older); go on to the options.
 * - `settings`: this window can't change it from here; Settings › Fleet at that machine.
 * `devices` is that machine's paired devices as this window reads them, `self` marking its own;
 * `refused` when it may not read them (not an administrator there), `pending` while it reads.
 */
export function allowProjectsOffer(input: {
  /** Whether this window reaches that machine now. */
  reached: boolean;
  deviceId: string;
  devices:
    | "pending"
    | "refused"
    | readonly { id: string; scopes: readonly DeviceScope[]; self?: boolean }[];
}): "checking" | "allow" | "viewOnly" | "held" | "settings" {
  if (!input.reached || input.devices === "refused") return "settings";
  if (input.devices === "pending") return "checking";
  const link = input.devices.find((device) => device.id === input.deviceId);
  if (!link) return "settings";
  if (!link.scopes.includes("operate") && !link.scopes.includes("admin")) return "viewOnly";
  if (link.scopes.includes("projects")) return "held";
  const self = input.devices.find((device) => device.self);
  // Not listed: this window is that machine's own app, which holds every scope.
  if (!self) return "allow";
  return self.scopes.includes("projects") || self.scopes.includes("desktop") ? "allow" : "settings";
}

/**
 * Why a machine refused changing a link's scopes, in words the person acts on. A daemon from
 * before `scope` can't parse it and answers `invalid_message` (or `unsupported`).
 */
export function scopeChangeRefusal(code: string, machine: string): string | undefined {
  if (code === "invalid_message" || code === "unsupported")
    return `${machine} runs an older ace that can't allow projects from here. Update ace there, or unlink and link them again in Settings › Fleet.`;
  return undefined;
}

/** The offer `allowProjectsOffer` makes. */
export type AllowProjectsOffer = ReturnType<typeof allowProjectsOffer>;

/**
 * The one sentence the Allow projects step says for `offer`: `machine` is where the work would
 * go, `sender` the machine it comes from. A refused change says why instead.
 */
export function allowProjectsWords(input: {
  offer: AllowProjectsOffer;
  machine: string;
  sender: string;
  /** The code a refused scope change answered, once it did. */
  refused?: string | undefined;
}): string {
  const { offer, machine, sender, refused } = input;
  if (refused !== undefined)
    return scopeChangeRefusal(refused, machine) ?? fleetRefusal(refused, machine);
  const why = `${machine} doesn't take projects from ${sender} yet`;
  switch (offer) {
    case "viewOnly":
      return `${sender}'s link can only view on ${machine}, so it can't take projects; unlink and link them again in Settings › Fleet.`;
    case "held":
      return `${machine} takes projects from ${sender} now.`;
    case "settings":
      return `${why}; allow them on ${machine} in Settings › Fleet.`;
    default:
      return `${why}.`;
  }
}

/** A link made while this window couldn't grant Projects there: how to allow them later. */
export function linkedWithoutProjects(machine: string): { title: string; words: string } {
  return {
    title: `Linked without Projects on ${machine}`,
    words: `This device can't grant Projects on ${machine}, so work can't move there yet. Allow projects on ${machine}'s page in Settings › Fleet.`,
  };
}

/** Where the work goes on the other machine. */
export interface Placement {
  hostId: string;
  parent?: string | undefined;
  includeChanges: boolean;
  /** Omitted: the sending machine's "Bring ignored files" setting. */
  includeIgnored?: boolean | undefined;
}

/** What "Try again" repeats: the transfer's own options, as its record echoes them. */
export function placementOf(transfer: Transfer): Placement | undefined {
  const options = transfer.options;
  if (!options) return undefined;
  return {
    hostId: transfer.target.hostId,
    ...(options.parent ? { parent: options.parent } : {}),
    includeChanges: options.includeChanges,
    includeIgnored: options.includeIgnored,
  };
}

/** What a thread's line says about where its work went or came from. */
export type ThreadTransferState =
  | { kind: "transfer"; transfer: Transfer }
  /** Its work moved there while it worked and goes on there (ADR 0191). */
  | { kind: "moved"; to: Extract<ThreadStatus, { state: "moved" }>["to"] }
  | { kind: "on"; on: ThreadContinuedOn }
  | { kind: "from"; from: ThreadContinuedOn };

/** The thread's line when no transfer is running: where its work went or came from. */
export function continuedWords(state: Exclude<ThreadTransferState, { kind: "transfer" }>): {
  words: string;
  where: Pick<ThreadContinuedOn, "hostId" | "threadId">;
} {
  switch (state.kind) {
    case "moved":
      return { words: `Moved to ${state.to.name}`, where: state.to };
    case "on":
      return { words: `Continued on ${state.on.name}`, where: state.on };
    case "from":
      return { words: `Continued from ${state.from.name}`, where: state.from };
  }
}

/**
 * A running transfer first, then one that failed after the last continuation (until it's
 * dismissed), then where the thread was continued, a finished transfer whose record hasn't
 * reached the thread yet, then where it came from. Cancelled transfers say nothing.
 */
export function threadTransferState(
  transfer: Transfer | undefined,
  details: Pick<ThreadDetails, "continuedOn" | "continuedFrom"> | undefined,
  dismissed: boolean,
  status?: ThreadStatus,
): ThreadTransferState | undefined {
  const on = details?.continuedOn;
  if (transfer && transferRunning(transfer)) return { kind: "transfer", transfer };
  if (status?.state === "moved") return { kind: "moved", to: status.to };
  if (transfer?.phase === "failed" && !dismissed && (!on || transfer.updatedAt > on.at))
    return { kind: "transfer", transfer };
  if (on) return { kind: "on", on };
  if (transfer?.phase === "completed") return { kind: "transfer", transfer };
  if (details?.continuedFrom) return { kind: "from", from: details.continuedFrom };
  return undefined;
}
