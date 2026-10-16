import { useEffect, useState } from "react";
import { SettingsValues, type SettingsProvenance } from "@ace/protocol";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { fieldClassName } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { subscribeSettings } from "@/lib/settings-subscription.ts";
import { settingRow } from "./settings-index.ts";

const all = "all";
const msPerMinute = 60_000;

/**
 * Worktree preparation deadline, per environment (machine). Each daemon enforces its own
 * `worktree.preparationTimeoutMs` (10 minutes by default); `ACE_WORKTREE_PREPARATION_TIMEOUT_MS`
 * pins it with `environment` provenance. The environment filter mirrors Usage/Limits.
 */
export function WorktreePreparationSettings() {
  const machines = useMachines();
  const online = machines.filter((machine) => machine.client !== undefined);
  const [environmentId, setEnvironmentId] = useState<string>(all);
  const selected =
    environmentId === all
      ? online
      : online.filter((machine) =>
          environmentId === "primary" ? machine.primary : machine.id === environmentId,
        );
  const options = [
    { value: all, label: "All environments" },
    ...online.map((machine) => ({ value: machine.id, label: machine.name })),
  ];
  const row = settingRow("advanced.worktreeTimeout");
  return (
    <SettingSection
      label="Worktree"
      scope="daemon"
      actions={
        <FilterMenu
          label="Environment"
          value={environmentId}
          options={options}
          onValueChange={setEnvironmentId}
        />
      }
    >
      {selected.length === 0 ? (
        <SettingNote>No environments online. Connect to a machine to see its timeout.</SettingNote>
      ) : (
        selected.map((machine) => (
          // The primary machine's id arrives with its identity; its key stays stable so its
          // row (and its input's focus) survives that load.
          <MachineTimeoutRow
            key={machine.primary ? "primary" : machine.id}
            machine={machine}
            anchor={row.id}
          />
        ))
      )}
    </SettingSection>
  );
}

function MachineTimeoutRow(props: { machine: Machine; anchor: string }) {
  const { machine } = props;
  const rowKey = machine.primary ? "primary" : machine.id;
  const [minutes, setMinutes] = useState<number>();
  const [provenance, setProvenance] = useState<SettingsProvenance>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const client = machine.client;
    if (!client) return;
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
  }, [machine.client]);
  const pinned = provenance === "environment";
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const commit = async () => {
    if (draft === undefined || !machine.client) return;
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
      const reply = await machine.client.request({
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
    <>
      <SettingRow
        id={`${props.anchor}-${rowKey}`}
        title={<MachineLabel name={machine.name} icon={machine.icon} primary={machine.primary} />}
        description={
          pinned
            ? `Preparation timeout is set by ACE_WORKTREE_PREPARATION_TIMEOUT_MS on this machine.`
            : `How long read-only Git work before git worktree add may take.`
        }
      >
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            aria-label={`Preparation timeout in minutes on ${machine.name}`}
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            className={cn(
              fieldClassName,
              "h-8 w-24 tabular-nums",
              "[appearance:textfield]",
              "[&::-webkit-inner-spin-button]:appearance-none",
              "[&::-webkit-outer-spin-button]:appearance-none",
            )}
            value={draft ?? minutes ?? ""}
            disabled={!machine.client || saving || minutes === undefined || pinned}
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
    </>
  );
}
