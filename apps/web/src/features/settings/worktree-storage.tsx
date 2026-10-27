import { useState } from "react";
import { useConnectionState } from "@ace/client-react";
import { RetentionDays, type StorageUsage } from "@ace/protocol";
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

export function WorktreeStorageSettings(props: {
  busy: boolean;
  onPreviewAll(): void;
  onSaved(): void;
}) {
  const ready = useConnectionState() === "ready";
  const [days, setDays] = useDaemonSetting("storage.worktreeRetentionDays");
  const [backup, setBackup] = useDaemonSetting("storage.backupWorktrees");
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
      <SettingRow title="Automatic deletion" inline>
        <Switch
          aria-label="Automatic worktree deletion"
          checked={typeof days === "number"}
          disabled={disabled || days === undefined}
          onCheckedChange={(enabled) => void save(() => setDays(enabled ? 30 : null))}
        />
      </SettingRow>
      <SettingRow title="Delete after settling" inline>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            aria-label="Days after settling"
            type="number"
            min={1}
            max={3650}
            inputMode="numeric"
            className={cn(fieldClassName, "h-8 w-24 tabular-nums")}
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
      <SettingRow
        title="Back up to origin"
        description="Commits everything not in .gitignore, .env included, and pushes to origin."
        inline
      >
        <Switch
          aria-label="Back up worktrees to origin"
          checked={backup ?? false}
          disabled={disabled || backup === undefined}
          onCheckedChange={(enabled) => void save(() => setBackup(enabled))}
        />
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
  const failed = props.backups.filter((backup) => backup.state === "failed");
  if (!failed.length) return null;
  const shown = failed.slice(0, 3);
  return (
    <SettingNote role="alert">
      {failed.length === 1
        ? "Backup failed for 1 worktree. It was kept."
        : `Backup failed for ${failed.length} worktrees. They were kept.`}
      {shown.map((backup) => (
        <span key={backup.path} className="mt-1 block break-all">
          {backup.path}
          {backup.error ? ` · ${backup.error}` : ""}
        </span>
      ))}
      {failed.length > shown.length && (
        <span className="mt-1 block">and {failed.length - shown.length} more</span>
      )}
    </SettingNote>
  );
}
