import type { AccountBadgeColor } from "@ace/protocol/accounts";
import type { AccountView } from "@ace/ui-core";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { accountColors, ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { Select } from "@/components/ui/select.tsx";

const colors: AccountBadgeColor[] = ["neutral", "blue", "green", "amber", "rose", "violet"];

export function AccountLabelEditor(props: {
  account: AccountView;
  onSave(name: string, badge: { shortLabel: string; badgeColor: AccountBadgeColor | null }): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(props.account.label);
  const [shortLabel, setLabel] = useState(props.account.shortLabel ?? "•");
  const [color, setColor] = useState<AccountBadgeColor>(props.account.badgeColor ?? "neutral");
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && shortLabel.trim())
      props.onSave(name.trim(), {
        shortLabel: shortLabel.trim(),
        badgeColor: color === "neutral" ? null : color,
      });
  };
  return (
    <form
      aria-label="Edit account label"
      onSubmit={save}
      className="flex min-w-0 flex-wrap items-center gap-2 py-1"
    >
      <ProviderAccountIcon
        provider={props.account.provider}
        account={{
          ...props.account,
          shortLabel,
          badgeColor: color === "neutral" ? undefined : color,
        }}
        size={20}
      />
      <Input
        aria-label="Account name"
        value={name}
        maxLength={128}
        onChange={(event) => setName(event.target.value)}
        className="h-8 w-28"
      />
      <Input
        aria-label="Short label"
        autoFocus
        value={shortLabel}
        maxLength={3}
        onChange={(event) => setLabel(event.target.value.replace(/\s/g, ""))}
        className="h-8 w-14"
      />
      <Select
        label="Label colour"
        value={color}
        options={colors.map((value) => ({
          value,
          label: value === "neutral" ? "No colour" : value[0]?.toUpperCase() + value.slice(1),
        }))}
        onValueChange={(value) => {
          const next = colors.find((entry) => entry === value);
          if (next) setColor(next);
        }}
      />
      <span aria-hidden style={{ color: accountColors[color] }}>
        ●
      </span>
      <Button type="submit" size="sm" disabled={!name.trim() || !shortLabel.trim()}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={props.onCancel}>
        Cancel
      </Button>
    </form>
  );
}
