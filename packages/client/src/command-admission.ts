import { ClientError } from "./types.ts";

/** Absence from a receipt-trimmed outbox is unavailable history, never proof of freshness. */
export type CommandAdmissionEvidence = "fresh" | "admitted" | "unknown";

/** A pre-enqueue refusal releases an ID only when its caller can prove it is newly allocated. */
export function commandAdmissionError(evidence: CommandAdmissionEvidence): ClientError {
  return new ClientError(evidence === "fresh" ? "not_dispatched" : "limit");
}
