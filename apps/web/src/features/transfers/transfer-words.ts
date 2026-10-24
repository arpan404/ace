import type { Transfer } from "@ace/protocol";
import { formatBytes } from "@/components/format-bytes.ts";

/*
 * What a transfer says, in one sentence (ADR 0099): "Sending to Studio · 312 MB of 1.2 GB",
 * "Continued on Studio", or the daemon's own words when it failed. Pure.
 */

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

/** Done: where the work is now. */
export function doneWords(transfer: Pick<Transfer, "kind" | "target">): string {
  return transfer.kind === "thread"
    ? `Continued on ${transfer.target.name}`
    : `Opened on ${transfer.target.name}`;
}

/** A refused command's code, in words a person acts on. */
export function refusalWords(code: string | undefined, machine: string): string {
  switch (code) {
    case "machine_not_linked":
      return `This machine isn't linked to ${machine}. Link them in Settings › Machines.`;
    case "machine_forbidden":
      return `${machine} doesn't allow projects from this machine. Link it again with Projects allowed.`;
    case "thread_busy":
      return "The thread is still working. Try again once it stops.";
    case "transfer_too_large":
      return "It's larger than 20 GB, too large to send.";
    case "forbidden":
      return "This window isn't allowed to manage projects on this machine.";
    case "offline":
      return "This machine isn't connected. Try again once it is.";
    default:
      return `Couldn't send it to ${machine}.`;
  }
}
