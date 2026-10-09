import { useThreadMeta } from "@ace/client-react";
import { unavailableSelection } from "@ace/ui-core";
import { useModelCatalog, useModelInstances } from "@/lib/model-catalog.ts";
import { runsOn } from "../composer/execution.ts";
import { useAccountViews } from "@/lib/account-views.ts";

/** A saved selection cannot silently become another model when discovery changes. */
export function useThreadModelAvailability(threadId: string) {
  const meta = useThreadMeta(threadId);
  const models = useModelCatalog();
  const instances = useModelInstances();
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
  const unavailable = unavailableSelection(models, selection, instances);
  // Availability resolves a legacy default route; pending effort keeps the recorded identity.
  return { selection: saved, unavailable };
}
