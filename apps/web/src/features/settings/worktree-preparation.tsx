import { useEffect, useState } from "react";
import { SettingsValues, type SettingsProvenance } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { fieldClassName } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";
import { subscribeSettings } from "@/lib/settings-subscription.ts";
import { settingRow } from "./settings-index.ts";

const msPerMinute = 60_000;

/**
 * The worktree preparation deadline of the machine Settings edits (`SettingsOutlet` renders the
 * page against it). Each daemon enforces its own `worktree.preparationTimeoutMs` (10 minutes by
 * default); `ACE_WORKTREE_PREPARATION_TIMEOUT_MS` pins it with `environment` provenance.
 */
export function WorktreePreparationSettings() {
  const client = useClient();
  const row = settingRow("advanced.worktreeTimeout");
  const [minutes, setMinutes] = useState<number>();
  const [provenance, setProvenance] = useState<SettingsProvenance>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const subscription = subscribeSettings(
      client,
      ["worktree.preparationTimeoutMs"],
      {},
      (entries) => {
        const found = entries.find((entry) => entry.key === "worktree.preparationTimeoutMs");
        if (!found) return;
        const parsed = SettingsValues.shape["worktree.preparationTimeoutMs"].safeParse(found.value);
        if (parsed.success) setMinutes(Math.round(parsed.data / msPerMinute));
        setProvenance(found.provenance);
      },
      () => {},
    );
    return () => subscription.stop();
  }, [client]);
  const pinned = provenance === "environment";
  const commit = async () => {
    if (draft === undefined) return;
    const value = Number(draft);
    if (draft === "" || value === minutes) {
      setDraft(undefined);
      return;
    }
    setSaving(true);
    try {
      const ms = Math.round(value * msPerMinute);
      const parsed = SettingsValues.shape["worktree.preparationTimeoutMs"].safeParse(ms);
      if (!parsed.success) throw new Error("Use 1 to 60 minutes.");
      const reply = await client.request({
        type: "settings.set",
        key: "worktree.preparationTimeoutMs",
        value: parsed.data,
        layer: { kind: "global" },
      });
      if (!reply.ok) throw new Error("Couldn't save that setting.");
      setError(undefined);
      setDraft(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save that setting.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingSection label="Worktrees" scope="daemon">
      <SettingRow
        {...row}
        description={
          pinned
            ? "Set by ACE_WORKTREE_PREPARATION_TIMEOUT_MS on this machine."
            : "How long setting up a new worktree may take before it fails."
        }
      >
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            aria-label="Preparation timeout in minutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            className={cn(
              fieldClassName,
              "h-8 w-20 tabular-nums",
              "[appearance:textfield]",
              "[&::-webkit-inner-spin-button]:appearance-none",
              "[&::-webkit-outer-spin-button]:appearance-none",
            )}
            value={draft ?? minutes ?? ""}
            disabled={saving || minutes === undefined || pinned}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") void commit();
              if (event.key === "Escape") setDraft(undefined);
            }}
          />
          min
        </span>
      </SettingRow>
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
    </SettingSection>
  );
}
