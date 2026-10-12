import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useClient, useConnectionState } from "@ace/client-react";
import { StorageKind, StorageRetention } from "@ace/protocol";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { storageLabels } from "./storage-copy.ts";

export function StorageRetentionControls(props: { onSaved(): void }) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [draft, setDraft] = useState<StorageRetention>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [scheduledDraft, setScheduledDraft] = useState<boolean>();
  const query = useQuery({
    queryKey: [client, "storage", "retention"],
    enabled: ready,
    queryFn: async () => {
      const [retention, scheduled] = await Promise.all([
        client.request({ type: "settings.get", key: "storage.retention", scope: {} }),
        client.request({ type: "settings.get", key: "storage.scheduledCleanup", scope: {} }),
      ]);
      if (!retention.ok || !scheduled.ok) throw new Error("Storage preferences are unavailable.");
      return {
        retention: StorageRetention.parse(
          retention.entries.find((entry) => entry.key === "storage.retention")?.value ?? {},
        ),
        scheduled:
          scheduled.entries.find((entry) => entry.key === "storage.scheduledCleanup")?.value ===
          true,
      };
    },
  });
  const values = draft ?? query.data?.retention;
  const save = async () => {
    if (!values) return;
    setRunning(true);
    setError(undefined);
    try {
      const parsed = StorageRetention.parse(values);
      const retention = await client.request({
        type: "settings.set",
        key: "storage.retention",
        value: parsed,
        layer: { kind: "global" },
      });
      if (!retention.ok)
        throw new Error("Host administrator access is required to save retention.");
      const scheduled = await client.request({
        type: "settings.set",
        key: "storage.scheduledCleanup",
        value: scheduledDraft ?? query.data?.scheduled ?? false,
        layer: { kind: "global" },
      });
      if (!scheduled.ok) throw new Error("Scheduled cleanup could not be saved.");
      props.onSaved();
      await query.refetch();
      setDraft(undefined);
      setScheduledDraft(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Retention could not be saved.");
    } finally {
      setRunning(false);
    }
  };
  return (
    <SettingSection label="Retention" scope="daemon">
      <p className="mb-3 text-sm text-muted-foreground">
        Keep archived threads and unused data for these many days. Leave a value empty to keep it
        indefinitely. Pins and live work always stay.
      </p>
      {values ? (
        StorageKind.options.map((kind) => (
          <SettingRow key={kind} title={storageLabels[kind]} inline>
            <input
              aria-label={`${storageLabels[kind]} retention days`}
              type="number"
              min={1}
              max={36500}
              className="w-24 rounded-md border bg-background px-2 py-1 text-sm tabular-nums focus-ring"
              placeholder="Keep"
              value={values[kind] ?? ""}
              disabled={!ready || running}
              onChange={(event) =>
                setDraft({
                  ...values,
                  [kind]: event.target.value === "" ? null : Number(event.target.value),
                })
              }
            />
          </SettingRow>
        ))
      ) : (
        <p role={query.isError ? "alert" : "status"}>
          {query.isError
            ? "Retention could not be loaded. Reconnect and try again."
            : "Loading retention…"}
        </p>
      )}
      <SettingRow
        title="Daily cleanup"
        description="Automatically applies the saved retention policy. Forced worktree removal stays manual."
        inline
      >
        <input
          type="checkbox"
          aria-title="Daily cleanup"
          checked={scheduledDraft ?? query.data?.scheduled ?? false}
          disabled={!ready || running || !values}
          onChange={(event) => setScheduledDraft(event.target.checked)}
        />
      </SettingRow>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        size="sm"
        className="mt-3"
        disabled={!ready || running || !values}
        onClick={() => void save()}
      >
        {running ? "Saving…" : "Save retention"}
      </Button>
    </SettingSection>
  );
}
