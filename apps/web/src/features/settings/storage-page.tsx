import { useState } from "react";
import { useClient, useConnectionState } from "@ace/client-react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import type { StorageApply, StorageCompaction, StoragePlan, StorageRequest } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import {
  SettingFooter,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";
import { StorageRetentionControls } from "./storage-retention.tsx";
import { DataRetentionSettings } from "./data-retention.tsx";
import { StorageCompactAction, StoragePlanPreview } from "./storage-plan.tsx";
import { storageBytes, storageLabels } from "./storage-copy.ts";
import { WorktreeStorageSettings } from "./worktree-storage.tsx";
import { StorageRetention } from "@ace/protocol";

/**
 * Settings › Storage for the machine Settings edits: what its data takes, a reviewed cleanup,
 * compaction, and how long each kind of data is kept.
 */
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
  const usage = useDaemonQuery({
    queryKey: ["storage", "usage"],
    read: async (daemon, signal) => {
      const reply = await daemon.request(
        { type: "storage.request", operation: { op: "storage.usage" } },
        { signal },
      );
      const response = reply.result;
      if (response.kind !== "usage") throw new Error("Unexpected storage response.");
      return response.usage;
    },
  });
  const preview = async (
    operation: Extract<StorageRequest["operation"], { op: "cleanup.plan" }>,
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await request(operation);
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
  const previewWorktrees = () =>
    preview({
      op: "cleanup.plan",
      kinds: ["worktrees"],
      retention: StorageRetention.parse({ worktreeMode: "all_settled" }),
      forceItems,
    });
  const previewCleanup = () =>
    forceItems.length && plan?.retention.worktreeMode === "all_settled"
      ? previewWorktrees()
      : preview({ op: "cleanup.plan", forceItems });
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
              <SettingRow
                key={category.kind}
                title={storageLabels[category.kind]}
                description={`${category.items} items`}
                inline
              >
                <span className="text-sm tabular-nums text-muted-foreground">
                  {storageBytes(category.bytes)}
                </span>
              </SettingRow>
            ))}
            <SettingRow
              title="Transcript database"
              description={`${storageBytes(usage.data.reclaimableDatabaseBytes)} can be reclaimed by compacting.`}
              inline
            >
              <span className="text-sm tabular-nums text-muted-foreground">
                {storageBytes(usage.data.databaseBytes)}
              </span>
            </SettingRow>
            {/* Compaction gives those unused pages back; it sits beside the size it changes. */}
            <StorageCompactAction
              result={compaction}
              busy={busy}
              disabled={!ready}
              onCompact={() => void compact({ op: "cleanup.compact" })}
              onAbandon={(compactionId) =>
                void compact({ op: "cleanup.compactAbandon", compactionId })
              }
            />
            {!usage.data.complete && (
              <SettingNote>Measured in a bounded batch; refresh for more.</SettingNote>
            )}
            {usage.data.backups
              .filter((backup) => backup.state === "failed")
              .map((backup) => (
                <SettingNote key={backup.path} role="alert">
                  Backup failed for <span className="break-all">{backup.path}</span>. The worktree
                  was kept. Check origin access and refresh after the next backup.
                </SettingNote>
              ))}
          </>
        ) : (
          <SettingNote role={usage.isError ? "alert" : "status"}>
            {usage.isError
              ? "Couldn't measure storage. Refresh to try again."
              : ready
                ? "Measuring storage…"
                : "Reconnect to measure storage."}
          </SettingNote>
        )}
        <SettingFooter>
          <Button
            size="sm"
            variant="ghost"
            disabled={!ready || busy}
            onClick={() => void usage.refetch()}
          >
            Refresh usage
          </Button>
          <Button size="sm" disabled={!ready || busy} onClick={() => void previewCleanup()}>
            {busy
              ? "Working…"
              : forceItems.length
                ? "Preview selected force removals"
                : "Preview cleanup"}
          </Button>
        </SettingFooter>
        {error && (
          <SettingNote role="alert" className="text-destructive">
            {error}
          </SettingNote>
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
      <WorktreeStorageSettings
        busy={busy}
        onPreviewAll={() => void previewWorktrees()}
        onSaved={() => {
          setPlan(undefined);
          setResult(undefined);
          setForceItems([]);
        }}
      />
      <DataRetentionSettings />
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
