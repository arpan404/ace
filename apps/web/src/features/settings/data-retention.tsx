import { useState } from "react";
import { useConnectionState } from "@ace/client-react";
import { LogMaxBytes, RetentionDays } from "@ace/protocol";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { fieldClassName } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";
import { useDaemonSetting, useDaemonSettingProvenance } from "@/lib/daemon-setting.ts";

const MiB = 1024 * 1024;

/**
 * The host's data window and log cap. Saving goes through the daemon, which applies the value
 * at once and pushes it to every connected client.
 */
export function DataRetentionSettings() {
  const [days, setDays] = useDaemonSetting("storage.retentionDays");
  const [logBytes, setLogBytes] = useDaemonSetting("logs.maxBytes");
  const daysSource = useDaemonSettingProvenance("storage.retentionDays");
  const logSource = useDaemonSettingProvenance("logs.maxBytes");
  const [error, setError] = useState<string>();
  return (
    <SettingSection label="Data" scope="daemon">
      <NumberRow
        title="Keep data for"
        unit="days"
        value={days}
        pinnedBy={daysSource === "environment" ? "ACE_RETENTION_DAYS" : undefined}
        min={1}
        max={3650}
        onSave={async (value) => {
          const parsed = RetentionDays.safeParse(value);
          if (!parsed.success) throw new Error("Keep data for 1 to 3650 days.");
          await setDays(parsed.data);
        }}
        onError={setError}
      />
      <NumberRow
        title="Log limit"
        unit="MB"
        value={logBytes === undefined ? undefined : Math.round(logBytes / MiB)}
        pinnedBy={logSource === "environment" ? "ACE_LOG_MAX_BYTES" : undefined}
        min={1}
        max={65536}
        onSave={async (value) => {
          const parsed = LogMaxBytes.safeParse(value * MiB);
          if (!parsed.success) throw new Error("Log limit is 1 to 65536 MB.");
          await setLogBytes(parsed.data);
        }}
        onError={setError}
      />
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
    </SettingSection>
  );
}

function NumberRow(props: {
  title: string;
  unit: string;
  value: number | undefined;
  /** The host variable that overrides the saved value, if any. */
  pinnedBy: string | undefined;
  min: number;
  max: number;
  onSave(value: number): Promise<void>;
  onError(message: string | undefined): void;
}) {
  const ready = useConnectionState() === "ready";
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const commit = async () => {
    if (draft === undefined) return;
    const value = Number(draft);
    if (draft === "" || value === props.value) {
      setDraft(undefined);
      return;
    }
    setSaving(true);
    try {
      await props.onSave(value);
      props.onError(undefined);
      setDraft(undefined);
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : "Couldn't save that setting.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingRow
      title={props.title}
      density="compact"
      inline
      description={props.pinnedBy ? `Set by ${props.pinnedBy} on the host` : undefined}
    >
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          aria-label={`${props.title} (${props.unit})`}
          type="number"
          inputMode="numeric"
          min={props.min}
          max={props.max}
          className={cn(fieldClassName, "h-8 w-24 tabular-nums")}
          value={draft ?? props.value ?? ""}
          disabled={!ready || saving || props.value === undefined || props.pinnedBy !== undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commit();
            if (event.key === "Escape") setDraft(undefined);
          }}
        />
        {props.unit}
      </span>
    </SettingRow>
  );
}
