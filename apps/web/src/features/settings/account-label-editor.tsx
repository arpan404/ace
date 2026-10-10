import { AccountBadgeField, accountBadgeProblem } from "@/components/ui/account-badge-field.tsx";
import type { AccountBadgeColor } from "@ace/protocol/accounts";
import type { AccountView } from "@ace/ui-core";
import { useRef, useState, type RefObject, type FormEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";

export function AccountLabelEditor(props: {
  account: AccountView;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onSave(
    name: string,
    badge: {
      shortLabel?: string | undefined;
      badgeUsesInitial: boolean;
      badgeColor: AccountBadgeColor | null;
    },
  ): Promise<void>;
  onCancel(): void;
}) {
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(props.account.label);
  const [shortLabel, setLabel] = useState(
    props.account.badgeUsesInitial ? "" : (props.account.shortLabel ?? ""),
  );
  const [color, setColor] = useState<AccountBadgeColor>(props.account.badgeColor ?? "neutral");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || accountBadgeProblem(shortLabel) || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await props.onSave(name.trim(), {
        shortLabel: shortLabel.trim() || undefined,
        badgeUsesInitial: !shortLabel.trim(),
        badgeColor: color === "neutral" ? null : color,
      });
    } catch {
      setError("Couldn't save this account. Check your connection and retry.");
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && props.onCancel()}>
      <DialogContent initialFocus={nameInput} finalFocus={props.returnFocus}>
        <DialogHeader>
          <DialogTitle>Edit {props.account.label}</DialogTitle>
          <DialogDescription>
            Choose a name and badge. Leave the badge blank to use the name's initial.
          </DialogDescription>
        </DialogHeader>
        <form
          aria-label="Edit account label"
          onSubmit={(event) => void save(event)}
          className="grid gap-4"
        >
          <Input
            ref={nameInput}
            aria-label="Account name"
            value={name}
            maxLength={128}
            onChange={(event) => setName(event.target.value)}
            disabled={saving}
          />
          <fieldset disabled={saving}>
            <AccountBadgeField
              provider={props.account.provider}
              value={shortLabel}
              onChange={setLabel}
              name={name}
              color={color}
              onColorChange={setColor}
            />
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={props.onCancel}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={saving || !name.trim() || !!accountBadgeProblem(shortLabel)}
            >
              {saving ? "Saving…" : error ? "Retry" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
