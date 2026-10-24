import type { Transfer } from "@ace/protocol";
import { formatBytes } from "@/components/format-bytes.ts";
import type { Refusal } from "./use-transfer-actions.ts";

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

/** Done: where the work is now, and how many ignored files that project already had. */
export function doneWords(transfer: Pick<Transfer, "kind" | "target" | "result">): string {
  const done =
    transfer.kind === "thread"
      ? `Continued on ${transfer.target.name}`
      : `Opened on ${transfer.target.name}`;
  const kept = transfer.result?.ignoredSkipped ?? 0;
  if (!kept) return done;
  return `${done} · kept its own copy of ${kept} ignored ${kept === 1 ? "file" : "files"}`;
}

/**
 * A refused command in words a person acts on: the daemon's own words when it gave them, else
 * its code's.
 */
export function refusalWords(refusal: Refusal, machine: string): string {
  return refusal.detail || codeWords(refusal.code, machine);
}

function codeWords(code: string | undefined, machine: string): string {
  switch (code) {
    case "machine_not_linked":
      return `This machine isn't linked to ${machine}. Link them in Settings › Fleet.`;
    case "machine_forbidden":
      return `${machine} doesn't allow projects from this machine. Link it again with Projects allowed.`;
    case "machine_offline":
      return `${machine} is offline or unreachable. Try again once it's on.`;
    case "thread_busy":
      return "The thread is still working. Try again once it stops.";
    case "workspace_change_in_progress":
    case "workspace_preparing":
      return "The thread's checkout is still being made. Try again once it's ready.";
    case "thread_not_found":
      return "That thread isn't on this machine any more.";
    case "workspace_not_found":
      return "That project isn't on this machine any more.";
    case "workspace_unavailable":
      return "This machine can't send projects right now. Try again in a moment.";
    case "transfer_too_large":
      return "It's larger than 20 GB, too large to send.";
    case "not_found":
      return "That transfer isn't on this machine any more.";
    case "forbidden":
      return "This window isn't allowed to manage projects on this machine.";
    case "offline":
      return "This machine isn't connected. Try again once it is.";
    default:
      return `Couldn't send it to ${machine}.`;
  }
}
