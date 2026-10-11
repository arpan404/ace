import { AddMachine } from "./add-machine.tsx";
import { machineStatus, machineProblem } from "@/lib/machine-status.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { useState } from "react";
import type { MachineIcon } from "@ace/protocol";
import {
  CheckIcon,
  PencilSimpleIcon,
  PlusIcon,
  ArrowClockwiseIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { useMachinePool } from "@/lib/machine-pool.ts";
import { MachineLabel, MachineMark } from "@/components/ui/machine-label.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";

const kinds: readonly { value: MachineIcon["kind"]; label: string }[] = [
  { value: "laptop", label: "Laptop" },
  { value: "desktop", label: "Desktop" },
  { value: "server", label: "Server" },
  { value: "cloud", label: "Cloud" },
  { value: "phone", label: "Phone" },
  { value: "emoji", label: "Emoji" },
];
const colors: readonly { value: NonNullable<MachineIcon["color"]>; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "purple", label: "Purple" },
  { value: "orange", label: "Orange" },
];

/** The directory owns connected machines; paired phones and browsers below are access grants. */
export function Machines() {
  const machines = useMachines();
  const pool = useMachinePool();
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const [editing, setEditing] = useState<Machine>();
  return (
    <SettingSection label="Machines">
      <SettingRow
        compact
        inline
        title="Add machine"
        description="Use a pairing link from another computer"
      >
        <IconButton icon={PlusIcon} size="sm" label="Add machine" onClick={() => setAdding(true)} />
      </SettingRow>
      {adding && <AddMachine onClose={() => setAdding(false)} />}
      {machines.map((machine) => (
        <SettingRow
          key={machine.primary ? "primary" : machine.id}
          {...(machine.primary ? { id: "host.displayName" } : {})}
          compact
          inline
          title={<MachineLabel name={machine.name} icon={machine.icon} />}
          description={
            machine.primary ? "This machine" : machineProblem(machine.status, !!machine.failed)
          }
        >
          <StatusLabel
            tone={machineStatus[machine.status].tone}
            label={machineStatus[machine.status].label}
          />
          {!machine.primary && (
            <>
              <IconButton
                icon={ArrowClockwiseIcon}
                size="sm"
                label={`Reconnect ${machine.name}`}
                disabled={machine.status === "online" || machine.status === "connecting"}
                onClick={() => pool?.reconnect(machine.id)}
              />
              <IconButton
                icon={TrashIcon}
                size="sm"
                label={`Forget ${machine.name}`}
                onClick={() =>
                  void pool?.remove(machine.id).then(
                    () => toast.add({ title: `${machine.name} forgotten` }),
                    () => toast.error({ title: "Couldn't forget this machine. Try again." }),
                  )
                }
              />
            </>
          )}
          <IconButton
            icon={PencilSimpleIcon}
            size="sm"
            label={`Edit ${machine.primary ? "this machine" : machine.name}`}
            disabled={!machine.client}
            reason={
              !machine.client ? "Connect to this machine to edit its name and icon" : undefined
            }
            onClick={() => setEditing(machine)}
          />
        </SettingRow>
      ))}
      {editing && (
        <MachineEditor
          machine={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async (name, icon) => {
            if (!editing.primary) await pool?.rename(editing.id, name, icon);
          }}
        />
      )}
    </SettingSection>
  );
}

function MachineEditor(props: {
  machine: Machine;
  onClose(): void;
  onSaved(name: string, icon: MachineIcon): Promise<void>;
}) {
  const [name, setName] = useState(props.machine.name);
  const [icon, setIcon] = useState<MachineIcon>(props.machine.icon ?? { kind: "laptop" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const save = async () => {
    if (!props.machine.client) return;
    setSaving(true);
    setError(false);
    try {
      // Settings are host-owned, so the same identity survives restarts and other clients.
      const renamed = await props.machine.client.request({
        type: "settings.set",
        key: "host.displayName",
        value: name.trim(),
        layer: { kind: "global" },
      });
      if (!renamed.ok) throw new Error("refused");
      const savedIcon = {
        kind: icon.kind,
        color: icon.color ?? "default",
        ...(icon.kind === "emoji" ? { emoji: icon.emoji?.trim() || "💻" } : {}),
      };
      const marked = await props.machine.client.request({
        type: "settings.set",
        key: "host.icon",
        value: savedIcon,
        layer: { kind: "global" },
      });
      if (!marked.ok) throw new Error("refused");
      const { identity } = await props.machine.client.request({ type: "host.identity" });
      await props.onSaved(identity.displayName, identity.icon ?? savedIcon);
      props.onClose();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.machine.primary ? "This machine" : "Edit machine"}</DialogTitle>
          <DialogDescription>
            Choose the name and icon shown wherever this machine appears.
          </DialogDescription>
        </DialogHeader>
        <label className="text-sm" htmlFor="machine-name">
          Machine name
        </label>
        <Input
          id="machine-name"
          value={name}
          maxLength={256}
          onChange={(event) => setName(event.target.value)}
          disabled={saving}
        />
        <fieldset disabled={saving} className="flex flex-wrap gap-1">
          <legend className="mb-2 text-sm">Icon</legend>
          {kinds.map((kind) => (
            <Button
              key={kind.value}
              size="sm"
              variant="ghost"
              aria-label={kind.label}
              aria-pressed={icon.kind === kind.value}
              onClick={() => setIcon({ ...icon, kind: kind.value })}
            >
              {icon.kind === kind.value ? (
                <CheckIcon aria-hidden size={14} />
              ) : (
                <MachineMark icon={{ kind: kind.value, emoji: icon.emoji ?? "💻" }} />
              )}
              {kind.label}
            </Button>
          ))}
        </fieldset>
        {icon.kind === "emoji" ? (
          <>
            <label htmlFor="machine-emoji" className="text-sm">
              Emoji
            </label>
            <Input
              id="machine-emoji"
              value={icon.emoji ?? "💻"}
              maxLength={16}
              onChange={(event) => setIcon({ ...icon, emoji: event.target.value })}
              disabled={saving}
            />
          </>
        ) : (
          <Select
            label="Icon colour"
            value={icon.color ?? "default"}
            options={colors}
            onValueChange={(color) => setIcon({ ...icon, color })}
            disabled={saving}
          />
        )}
        <MachineLabel name={name || "This machine"} icon={icon} />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            Couldn't save the machine identity. Check the connection and administrator access, then
            try again.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
