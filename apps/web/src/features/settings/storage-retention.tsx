import { useState } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useClient, useConnectionState } from "@ace/client-react";
import { StorageKind, StorageRetention } from "@ace/protocol";
import {
  SettingFooter,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";
import { fieldClassName } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { cn } from "@/lib/cn.ts";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { storageLabels } from "./storage-copy.ts";

export function StorageRetentionControls(props: { onSaved(): void }) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const [draft, setDraft] = useState<StorageRetention>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [scheduledDraft, setScheduledDraft] = useState<boolean>();
  const query = useDaemonQuery({
    queryKey: ["storage", "retention"],
    read: async (daemon) => {
      const [retention, scheduled] = await Promise.all([
        daemon.request({ type: "settings.get", key: "storage.retention", scope: {} }),
        daemon.request({ type: "settings.get", key: "storage.scheduledCleanup", scope: {} }),
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
        throw new Error("Couldn't save retention. Administrator access is required.");
      const scheduled = await client.request({
        type: "settings.set",
        key: "storage.scheduledCleanup",
        value: scheduledDraft ?? query.data?.scheduled ?? false,
        layer: { kind: "global" },
      });
      if (!scheduled.ok) throw new Error("Couldn't save daily cleanup.");
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
    <SettingSection
      label="Retention"
      scope="daemon"
      note="Days to keep archived threads and unused data, by kind. Empty keeps it; pins and live work always stay."
    >
      {values ? (
        StorageKind.options.map((kind) => (
          <SettingRow
            key={kind}
            title={storageLabels[kind]}
            description={kind === "worktrees" ? "Archived threads only." : undefined}
            inline
          >
            <input
              aria-label={`${storageLabels[kind]} retention days`}
              type="number"
              min={1}
              max={36500}
              className={cn(fieldClassName, "h-8 w-24 tabular-nums")}
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
      ) : query.isError ? (
        <SettingNote role="alert">Couldn't load retention. Reconnect and try again.</SettingNote>
      ) : (
        <ListSkeleton label="retention" shape="row" rows={3} />
      )}
      <SettingRow
        title="Daily cleanup"
        description="Runs every day. Worktrees have their own setting."
        inline
      >
        <Switch
          aria-label="Daily cleanup"
          checked={scheduledDraft ?? query.data?.scheduled ?? false}
          disabled={!ready || running || !values}
          onCheckedChange={(checked) => setScheduledDraft(checked)}
        />
      </SettingRow>
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
      <SettingFooter>
        <Button size="sm" disabled={!ready || running || !values} onClick={() => void save()}>
          {running ? "Saving…" : "Save retention"}
        </Button>
      </SettingFooter>
    </SettingSection>
  );
}
