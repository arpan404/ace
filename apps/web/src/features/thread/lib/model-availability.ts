import { useThread, useThreadMeta } from "@ace/client-react";
import type { ThreadReader } from "@ace/client";
import { unavailableSelection, modelLabel, modelReplacement } from "@ace/ui-core";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { runsOn } from "../composer/execution.ts";

const holdOf = (reader: ThreadReader) => reader.queue;

/** A saved selection cannot silently become another model when discovery changes. */
export function useThreadModelAvailability(threadId: string) {
  const meta = useThreadMeta(threadId);
  const models = useModelCatalog();
  const queue = useThread(threadId, ["queue"], holdOf);
  const selection = runsOn(meta);
  const missing = unavailableSelection(models, selection);
  const failed = queue?.reason === "model_unavailable" && meta?.switch?.state !== "queued";
  const unavailable =
    missing ??
    (failed && selection?.model
      ? {
          provider: selection.provider,
          model: selection.model,
          label: modelLabel(selection.model),
          instance: selection.instanceId,
          replacement: modelReplacement(models, selection),
        }
      : undefined);
  return { selection, unavailable };
}
