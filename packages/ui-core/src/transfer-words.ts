import type { Transfer } from "@ace/protocol";
import { formatBytes } from "./byte-size.ts";

/*
 * What a transfer says, in one sentence (ADR 0101): "Sending to Studio · 312 MB of 1.2 GB",
 * "Continued on Studio", or the daemon's own words when it failed. Pure.
 */

/** Why the daemon refused: the receipt's code, and its own words when it gave them. */
export interface Refusal {
  code: string | undefined;
  detail?: string | undefined;
}

/** The running sentence, by phase. */
export function runningWords(transfer: Transfer): string {
  const to = transfer.target.name;
  switch (transfer.phase) {
    case "preparing":
      return `Getting ready to send to ${to}`;
    case "cloning":
      return `${to} is cloning the repository`;
    case "sending":
      return transfer.totalBytes
        ? `Sending to ${to} · ${formatBytes(transfer.sentBytes)} of ${formatBytes(transfer.totalBytes)}`
        : `Sending to ${to}`;
    case "importing":
      return `Setting up on ${to}`;
    case "starting":
      return `Starting the thread on ${to}`;
    default:
      return `Sending to ${to}`;
  }
}

const files = (count: number, kind = "") => `${count} ${kind}${count === 1 ? "file" : "files"}`;

/**
 * Done: where the work is now, the branch it is on when the checkout there was busy and left
 * alone, and how many files that project already had and kept.
 */
export function doneWords(transfer: Pick<Transfer, "kind" | "target" | "result">): string {
  const result = transfer.result;
  const done =
    transfer.kind === "thread"
      ? `Continued on ${transfer.target.name}`
      : `Opened on ${transfer.target.name}`;
  const parts = [
    result?.branchOnly && result.branch ? `${done} on ${result.branch}` : done,
    ...(result?.keptFiles ? [`kept its own copy of ${files(result.keptFiles)}`] : []),
    ...(result?.ignoredSkipped
      ? [`kept its own copy of ${files(result.ignoredSkipped, "ignored ")}`]
      : []),
  ];
  return parts.join(" · ");
}

/**
 * A refused command, cancel or failed transfer in words a person acts on: the daemon's own
 * words when it gave them, else its code's.
 */
export function refusalWords(refusal: Refusal, machine: string): string {
  return refusal.detail || codeWords(refusal.code, machine);
}

/** The daemon's stable codes (ADR 0101), for a refusal or failure that came without words. */
function codeWords(code: string | undefined, machine: string): string {
  switch (code) {
    // Starting one.
    case "transfers_unavailable":
    case "unavailable":
      return "Transfers aren't ready on this machine yet. Try again in a moment.";
    case "forbidden":
      return "This window isn't allowed to manage projects on this machine.";
    case "thread_not_found":
      return "That thread isn't on this machine any more.";
    case "thread_busy":
      return "The thread is still working. Try again once it stops.";
    case "workspace_change_in_progress":
      return "The thread's checkout is still being changed. Try again once that's done.";
    case "workspace_preparing":
      return "The thread's checkout is still being made. Try again once it's ready.";
    case "workspace_unavailable":
      return "This machine's projects are still starting. Try again in a moment.";
    case "workspace_not_found":
      return "That project isn't on this machine any more.";
    case "invalid":
    case "invalid_command":
      return "This window asked for something this machine doesn't understand. Update ace here or there.";
    case "machine_not_linked":
      return `This machine isn't linked to ${machine}. Link them in Settings › Fleet.`;
    case "machine_offline":
    case "machine_unavailable":
      return `${machine} is offline or unreachable. Try again once it's on.`;
    case "machine_forbidden":
    case "machine_refused":
      return `${machine} doesn't allow projects from this machine. Link it again with Projects allowed.`;
    // Cancelling.
    case "too_late":
      return `It already reached ${machine}; the work is there now.`;
    case "not_found":
      return "That transfer isn't on this machine any more.";
    // Failing on the way.
    case "transfer_corrupt":
      return `The copy on ${machine} didn't match what was sent. Try again.`;
    case "transfer_cancelled":
      return `Sending to ${machine} was cancelled.`;
    case "transfer_too_large":
      return "It's larger than 20 GB, too large to send.";
    case "ignored_unreadable":
      return "The files Git ignores couldn't be read. Try again without them.";
    case "clone_failed":
    case "import_failed":
    case "project_failed":
      return `${machine} couldn't set the project up. Try again.`;
    case "branch_unavailable":
      return `The branch couldn't be made on ${machine}.`;
    case "branch_diverged":
      return `The branch on ${machine} has moved on from this one.`;
    case "changes_conflict":
      return `The uncommitted changes don't apply cleanly on ${machine}.`;
    case "parent_not_allowed":
      return `That folder is outside the project folders ${machine} allows.`;
    case "provider_unavailable":
    case "engine_unavailable":
      return `${machine} can't start the thread's agent right now.`;
    case "offline":
      return "This machine isn't connected. Try again once it is.";
    default:
      return `Couldn't send it to ${machine}.`;
  }
}
