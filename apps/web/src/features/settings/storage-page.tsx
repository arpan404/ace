import { useState } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import { useQuery } from "@tanstack/react-query";
import type { StorageApply, StorageCompaction, StoragePlan, StorageRequest } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { StorageRetentionControls } from "./storage-retention.tsx";
import { StorageCompactAction, StoragePlanPreview } from "./storage-plan.tsx";
import { storageBytes, storageLabels } from "./storage-copy.ts";

export function StorageSettings() {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [plan, setPlan] = useState<StoragePlan>();
  const [result, setResult] = useState<StorageApply>();
  const [forceItems, setForceItems] = useState<string[]>([]);
  const [compaction, setCompaction] = useState<StorageCompaction>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = async (operation: StorageRequest["operation"]) => {
    const response = await client.request({ type: "storage.request", operation });
    if (response.result.kind === "error") throw new Error(response.result.message);
    return response.result;
  };
  const usage = useQuery({
    queryKey: [client, "storage", "usage"],
    enabled: ready,
    queryFn: async () => {
      const response = await request({ op: "storage.usage" });
      if (response.kind !== "usage") throw new Error("Unexpected storage response.");
      return response.usage;
    },
  });
  const preview = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await request({ op: "cleanup.plan", forceItems });
      if (response.kind !== "plan") throw new Error("Unexpected cleanup response.");
      setPlan(response.plan);
      setResult(undefined);
      setForceItems([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cleanup preview failed.");
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await request({
        op: "cleanup.apply",
        planId: plan.id,
        revision: plan.revision,
      });
      if (response.kind !== "apply") throw new Error("Unexpected cleanup response.");
      setResult(response.apply);
      await usage.refetch();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Cleanup could not finish. Resume this plan to retry.",
      );
    } finally {
      setBusy(false);
    }
  };
  const compact = async (operation: StorageRequest["operation"]) => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await request(operation);
      if (response.kind !== "compaction") throw new Error("Unexpected compaction response.");
      setCompaction(response.compaction);
      await usage.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Compaction could not finish.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingSection label="Usage" scope="daemon">
        {usage.data ? (
          <>
            {usage.data.categories.map((category) => (
              <SettingRow key={category.kind} title={storageLabels[category.kind]} inline>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {storageBytes(category.bytes)}
                </span>
              </SettingRow>
            ))}
            <SettingRow
              title="Transcript database"
              description={`${storageBytes(usage.data.reclaimableDatabaseBytes)} of unused pages SQLite can reuse.`}
              inline
            >
              <span className="text-sm tabular-nums text-muted-foreground">
                {storageBytes(usage.data.databaseBytes)}
              </span>
            </SettingRow>
            <p className="mt-2 text-xs text-muted-foreground">
              Thread sizes count stored payloads. Database disk usage is shown separately.
              {!usage.data.complete ? " This measurement covers a bounded batch." : ""}
            </p>
          </>
        ) : (
          <p role={usage.isError ? "alert" : "status"} className="text-sm">
            {usage.isError
              ? "Storage usage is unavailable. Refresh to try again."
              : ready
                ? "Measuring storage…"
                : "Reconnect to measure storage."}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!ready || busy}
            onClick={() => void usage.refetch()}
          >
            Refresh usage
          </Button>
          <Button size="sm" disabled={!ready || busy} onClick={() => void preview()}>
            {busy
              ? "Working…"
              : forceItems.length
                ? "Preview selected force removals"
                : "Preview cleanup"}
          </Button>
        </div>
        {usage.data && (
          <StorageCompactAction
            result={compaction}
            busy={busy}
            disabled={!ready}
            onCompact={() => void compact({ op: "cleanup.compact" })}
            onAbandon={(compactionId) =>
              void compact({ op: "cleanup.compactAbandon", compactionId })
            }
          />
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </SettingSection>
      {plan && (
        <StoragePlanPreview
          plan={plan}
          result={result}
          busy={busy}
          disabled={!ready}
          forceItems={forceItems}
          onForce={(id, selected) =>
            setForceItems((items) =>
              selected ? [...items, id] : items.filter((item) => item !== id),
            )
          }
          onApply={() => void apply()}
        />
      )}
      <StorageRetentionControls
        onSaved={() => {
          setPlan(undefined);
          setResult(undefined);
          setForceItems([]);
        }}
      />
    </>
  );
}
