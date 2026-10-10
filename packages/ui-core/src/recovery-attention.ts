import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import { threadAttention } from "@ace/projection";
import { unavailableSelection } from "./model-availability.ts";
import type { ThreadMarkKind, Tone } from "./status.ts";

export interface RecoveryAttention {
  label: string;
  tone: Tone;
  mark: ThreadMarkKind;
}

/** Recovery wording shared by rows, their spoken names and Activity. */
export function recoveryAttention(
  thread: ThreadListEntry,
  models: readonly CatalogModel[] | undefined,
  failedSend = false,
): RecoveryAttention | undefined {
  const reason = threadAttention(thread);
  if (reason === "not_sent" || failedSend)
    return { label: "Not sent", tone: "failed", mark: "failed" };
  if (unavailableSelection(models, thread.execution))
    return { label: "Pick a model", tone: "needs-you", mark: "needs-you" };
  if (reason === "model_unavailable") return { label: "Not sent", tone: "failed", mark: "failed" };
  const label =
    reason === "restart"
      ? "Stopped by a restart"
      : reason === "stopped"
        ? "Agent stopped"
        : reason === "uncertain"
          ? "Review a message"
          : reason === "manual"
            ? "Queue paused"
            : undefined;
  return label ? { label, tone: "waiting", mark: "none" } : undefined;
}
