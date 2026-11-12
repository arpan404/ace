import { useState } from "react";
import { useConnectionState } from "@ace/client-react";
import { RetentionDays, type StorageUsage } from "@ace/protocol";
import { failedBackupsView } from "@ace/ui-core/host-care";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import {
  SettingFooter,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { fieldClassName } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";
import { settingRow } from "./settings-index.ts";

/** Storage › Worktrees: deleting settled worktrees. Backing them up is on Settings › Agents. */
export function WorktreeStorageSettings(props: {
  busy: boolean;
  onPreviewAll(): void;
  onSaved(): void;
}) {
  const ready = useConnectionState() === "ready";
  const [days, setDays] = useDaemonSetting("storage.worktreeRetentionDays");
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const save = async (run: () => Promise<void>) => {
    setSaving(true);
    setError(undefined);
    try {
      await run();
      props.onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save worktree settings.");
    } finally {
      setSaving(false);
    }
  };
  const commitDays = async () => {
    if (draft === undefined || days === null) return;
    const parsed = RetentionDays.safeParse(Number(draft));
    if (!parsed.success) {
      setError("Keep settled worktrees for 1 to 3650 days.");
      return;
    }
    await save(() => setDays(parsed.data));
    setDraft(undefined);
  };
  const disabled = !ready || saving || props.busy;
  return (
    <SettingSection
      label="Worktrees"
      scope="daemon"
      note="Automatic deletion only removes clean worktrees merged into origin/main."
    >
      <SettingRow {...settingRow("storage.worktreeDeletion")} inline>
        <Switch
          aria-label="Automatic worktree deletion"
          checked={typeof days === "number"}
          disabled={disabled || days === undefined}
          onCheckedChange={(enabled) => void save(() => setDays(enabled ? 30 : null))}
        />
      </SettingRow>
      <SettingRow {...settingRow("storage.worktreeDays")} inline>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            aria-label="Days after settling"
            type="number"
            min={1}
            max={3650}
            inputMode="numeric"
            className={cn(fieldClassName, "h-8 w-20 tabular-nums")}
            value={draft ?? days ?? 30}
            disabled={disabled || typeof days !== "number"}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commitDays()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
              if (event.key === "Escape") setDraft(undefined);
            }}
          />
          days
        </span>
      </SettingRow>
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
      <SettingFooter>
        <Button
          size="sm"
          variant="secondary"
          tone="danger"
          disabled={disabled}
          onClick={props.onPreviewAll}
        >
          Delete all settled worktrees
        </Button>
      </SettingFooter>
    </SettingSection>
  );
}

/** One note for every failed backup, so a bad origin can't flood the page. */
export function FailedBackups(props: { backups: StorageUsage["backups"] }) {
  const view = failedBackupsView(props.backups);
  if (!view) return null;
  return (
    <SettingNote role="alert">
      {view.line}
      {view.entries.map((entry) => (
        <span key={entry.path} className="mt-1 block">
          <span className="block break-all font-mono text-xs">{entry.path}</span>
          <span className="block">{entry.reason}</span>
        </span>
      ))}
      {view.more && <span className="mt-1 block">{view.more}</span>}
    </SettingNote>
  );
}
