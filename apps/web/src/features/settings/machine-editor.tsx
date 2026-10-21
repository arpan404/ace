import { useState } from "react";
import type { MachineIcon } from "@ace/protocol";
import type { Machine } from "@/lib/machines.ts";
import {
  defaultMachineIcon,
  MachineLabel,
  MachineMark,
  machineIcons,
} from "@/components/ui/machine-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";

const colors: readonly { value: NonNullable<MachineIcon["color"]>; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "purple", label: "Purple" },
  { value: "orange", label: "Orange" },
];

/** Rename a machine and pick its icon; saved on that machine, so every device shows it. */
export function MachineEditor(props: {
  machine: Machine;
  onClose(): void;
  onSaved(name: string, icon: MachineIcon): Promise<void>;
}) {
  const [name, setName] = useState(props.machine.name);
  const [icon, setIcon] = useState<MachineIcon>(
    props.machine.icon ?? defaultMachineIcon(props.machine.primary),
  );
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
      const savedIcon = { kind: icon.kind, color: icon.color ?? "default" };
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
          <DialogDescription>Every device shows this name and icon.</DialogDescription>
        </DialogHeader>
        {/* A form, so Enter in the name saves. */}
        <form
          aria-label="Edit machine"
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!saving) void save();
          }}
        >
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
            {machineIcons.map((kind) => (
              <Tip key={kind.kind} label={kind.label}>
                <Button
                  type="button"
                  size="sm"
                  variant={icon.kind === kind.kind ? "secondary" : "ghost"}
                  className="size-8 px-0"
                  aria-label={kind.label}
                  aria-pressed={icon.kind === kind.kind}
                  onClick={() => setIcon({ ...icon, kind: kind.kind })}
                >
                  <MachineMark icon={{ kind: kind.kind, color: icon.color }} />
                </Button>
              </Tip>
            ))}
          </fieldset>
          <Select
            label="Icon colour"
            value={icon.color ?? "default"}
            options={colors}
            onValueChange={(color) => setIcon({ ...icon, color })}
            disabled={saving}
          />
          <MachineLabel name={name || "This machine"} icon={icon} primary={props.machine.primary} />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              Couldn't save the machine identity. Check the connection and administrator access,
              then try again.
            </p>
          )}
          <DialogFooter submitHint>
            <Button type="button" variant="ghost" disabled={saving} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
