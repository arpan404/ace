import { accountBadge } from "@/components/ui/account-badge.ts";
import { AccountBadgeField, accountBadgeProblem } from "@/components/ui/account-badge-field.tsx";
import type { AccountBadgeColor } from "@ace/protocol/accounts";
import type { AccountView } from "@ace/ui-core";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

export function AccountLabelEditor(props: {
  account: AccountView;
  onSave(name: string, badge: { shortLabel: string; badgeColor: AccountBadgeColor | null }): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(props.account.label);
  const [shortLabel, setLabel] = useState(props.account.shortLabel ?? "");
  const [color, setColor] = useState<AccountBadgeColor>(props.account.badgeColor ?? "neutral");
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !accountBadgeProblem(shortLabel))
      props.onSave(name.trim(), {
        shortLabel: accountBadge(name, shortLabel),
        badgeColor: color === "neutral" ? null : color,
      });
  };
  return (
    <form
      aria-label="Edit account label"
      onSubmit={save}
      className="flex min-w-0 flex-wrap items-center gap-2 py-1"
    >
      <Input
        aria-label="Account name"
        value={name}
        maxLength={128}
        onChange={(event) => setName(event.target.value)}
        className="h-8 w-28"
      />
      <AccountBadgeField
        provider={props.account.provider}
        value={shortLabel}
        onChange={setLabel}
        name={name}
        color={color}
        onColorChange={setColor}
      />
      <Button type="submit" size="sm" disabled={!name.trim() || !!accountBadgeProblem(shortLabel)}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={props.onCancel}>
        Cancel
      </Button>
    </form>
  );
}
