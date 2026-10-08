import { useThread, useThreadMeta } from "@ace/client-react";
import type { ThreadReader } from "@ace/client";
import { unavailableSelection, modelLabel, modelReplacement } from "@ace/ui-core";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { runsOn } from "../composer/execution.ts";
import { useAccountViews } from "@/lib/account-views.ts";

const holdOf = (reader: ThreadReader) => reader.queue;

/** A saved selection cannot silently become another model when discovery changes. */
export function useThreadModelAvailability(threadId: string) {
  const meta = useThreadMeta(threadId);
  const models = useModelCatalog();
  const queue = useThread(threadId, ["queue"], holdOf);
  const saved = runsOn(meta);
  const accounts = useAccountViews({ enabled: !!saved && saved.instanceId === undefined });
  const defaults = accounts.data?.filter(
    (account) => account.provider === saved?.provider && account.isDefault,
  );
  const instance = defaults?.length === 1 ? defaults[0]?.id : undefined;
  const selection =
    saved && saved.instanceId === undefined && instance
      ? { ...saved, instanceId: instance }
      : saved;
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
  // Availability resolves a legacy default route; pending effort keeps the recorded identity.
  return { selection: saved, unavailable };
}
