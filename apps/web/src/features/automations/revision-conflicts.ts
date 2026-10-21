import { AutomationError } from "./automations-source.ts";

/** Preserve the daemon refusal, already translated at the request boundary. */
export function staleWriteMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Couldn't save this automation. Check its fields and try again.";
}

/** A refused delete keeps its row and tells the person to review the latest revision. */
export function staleDeleteMessage(error: unknown): string {
  const reason =
    error instanceof AutomationError
      ? error.code
      : error instanceof Error
        ? error.message
        : undefined;
  return reason === "Automation revision conflict"
    ? "This automation changed elsewhere. Reload to see the latest before deleting."
    : staleWriteMessage(error);
}
