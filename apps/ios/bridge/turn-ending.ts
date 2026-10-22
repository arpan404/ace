import type { ThreadSource } from "@ace/client";
import {
  changedFileChips,
  errorRowText,
  failedTurnView,
  fileChipName,
  formatElapsed,
  summarizeChanges,
} from "@ace/ui-core";
import type { Block } from "@ace/ui-core/transcript-blocks";
import { preview } from "./presentation.ts";

/*
 * How a turn that didn't simply complete ended, and the files a turn changed, as the web's
 * transcript draws them (`turn-end.tsx`, `failed-turn.tsx`, `changed-files.tsx`): the person's
 * Stop as a thin "Interrupted by you" break; a restart as "Interrupted · after 3m"; a failure as
 * one "Turn failed · Composer 2.5 · …" row with the provider's own words behind Details; a usage
 * limit pause as the work it did. Pure over the store.
 */

type EndBlock = Extract<Block, { kind: "end" }>;

function failure(value: unknown): { kind: string; message: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kind = "kind" in value ? value.kind : undefined;
  const message = "message" in value ? value.message : undefined;
  return typeof kind === "string" && typeof message === "string" ? { kind, message } : undefined;
}

export function endingRow(store: ThreadSource, block: EndBlock) {
  const run = block.runId ? store.run(block.runId) : undefined;
  const ranMs = run?.endedAt === undefined ? undefined : run.endedAt - run.startedAt;
  const ran = ranMs !== undefined && ranMs >= 1000 ? formatElapsed(ranMs) : "";
  const base = {
    kind: block.ending,
    automatic: block.automatic === true,
    label: "",
    message: "",
    details: "",
    /** A failure the composer's strip already says (a usage or rate limit): no row here. */
    hidden: false,
  };
  if (block.ending === "paused") return { ...base, label: ran ? `Worked for ${ran}` : "Worked" };
  if (block.ending === "interrupted")
    return {
      ...base,
      label: block.automatic ? `Interrupted${ran ? ` · after ${ran}` : ""}` : "Interrupted by you",
    };
  const agentId = run?.agentId ?? store.thread?.rootAgentId;
  const status = agentId ? store.agent(agentId)?.status : undefined;
  const error =
    failure(run && "error" in run ? run.error : undefined) ??
    (block.latest && status?.state === "failed" ? failure(status.error) : undefined);
  const notice = block.errorId ? store.item(block.errorId) : undefined;
  const ask = block.askId ? store.item(block.askId) : undefined;
  const view = failedTurnView({
    notice,
    error,
    provider: store.thread?.provider,
    model:
      notice?.executionSource?.selection.model ??
      ask?.executionSource?.selection.model ??
      (block.latest ? store.thread?.execution?.model : undefined),
    latest: block.latest === true,
  });
  const text = errorRowText(view.error, view.heading);
  return {
    ...base,
    label: preview(text.title, 256),
    message: preview(text.message ?? "", 512),
    details: preview(text.details ?? "", 2048),
    hidden: view.limit,
  };
}

/** The files a turn changed, as chips: each file's name and `+N −M`, then "+N more". */
export function filesRow(store: ThreadSource, ids: readonly string[]) {
  const files = summarizeChanges(ids.map((id) => store.item(id)));
  const { chips, more, label } = changedFileChips(files);
  return {
    label,
    more,
    chips: chips.map((file) => ({
      path: preview(file.path, 512),
      name: preview(fileChipName(file.path), 256),
      added: file.stat.added,
      removed: file.stat.removed,
    })),
  };
}
