import { ParcelId, ThreadId, type ParcelView } from "@ace/protocol";
import { bytesText } from "./rules.ts";
import type { InRow, OutRow } from "./store.ts";

/** What agents read about parcels (ADR 0182): plain text, never another agent's words unmarked. */

function from(row: InRow): string {
  const title = row.facts.fromTitle ? `"${row.facts.fromTitle.slice(0, 120)}"` : "a thread";
  return `${title} (thread ${row.fromThread}${row.fromMachine ? ` on ${row.fromMachine}` : ""})`;
}

/** The receiving thread's notice; the note is the sending agent's, never the person's. */
export function arrivalText(row: InRow, path: string): string {
  const { name, size, sha256, note } = row.facts;
  const lines = [
    `Parcel ${row.parcelId} arrived from ${from(row)}: ${name}, ${bytesText(size)}, SHA-256 ${sha256} (checked).`,
    `A read-only copy is at ${path}. To keep it in your project, call data_receive with parcelId and saveAs.`,
  ];
  if (note) lines.push(`The sending agent's note (not the person's words): ${note}`);
  return lines.join("\n");
}

const where = (row: OutRow) =>
  row.route === "outbox"
    ? "your parent on the machine that delegated you"
    : `thread ${row.toThread}${row.machine ? ` on ${row.machine}` : ""}`;

/** The sending thread's result once the parcel settles. */
export function resultText(row: OutRow): string {
  const what = `Parcel ${row.parcelId} (${row.facts.name}, ${bytesText(row.facts.size)})`;
  if (row.state === "delivered")
    return `${what} was delivered to ${where(row)}; its SHA-256 was checked there.`;
  if (row.state === "cancelled") return `${what} to ${where(row)} was cancelled.`;
  return `${what} to ${where(row)} failed: ${row.error ?? "it stopped unexpectedly."}`;
}

export function sentView(row: OutRow): ParcelView {
  return {
    parcelId: ParcelId.parse(row.parcelId),
    direction: "sent",
    name: row.facts.name,
    size: row.facts.size,
    sha256: row.facts.sha256,
    state: row.state,
    peer: {
      threadId: ThreadId.parse(row.toThread),
      ...(row.machine ? { machine: row.machine.slice(0, 64) } : {}),
    },
    ...(row.facts.note ? { note: row.facts.note } : {}),
    ...(row.error ? { error: row.error.slice(0, 400) } : {}),
  };
}

export function receivedView(row: InRow, path: string | undefined): ParcelView {
  return {
    parcelId: ParcelId.parse(row.parcelId),
    direction: "received",
    name: row.facts.name,
    size: row.facts.size,
    sha256: row.facts.sha256,
    state:
      row.state === "delivered" ? "received" : row.state === "cancelled" ? "cancelled" : "sending",
    peer: {
      threadId: ThreadId.parse(row.fromThread),
      ...(row.fromMachine ? { machine: row.fromMachine.slice(0, 64) } : {}),
    },
    ...(row.facts.note ? { note: row.facts.note } : {}),
    ...(path ? { path } : {}),
  };
}
