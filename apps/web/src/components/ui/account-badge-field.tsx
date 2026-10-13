import {
  AccountBadgeInput,
  AccountBadgeColor,
  type AccountBadgeIcon,
} from "@ace/protocol/accounts";
import type { ProviderKind } from "@ace/protocol";
import { TextAaIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { Tip } from "./tooltip.tsx";
import { Input } from "./input.tsx";
import { Button } from "./button.tsx";
import { Disclosure } from "./disclosure.tsx";
import { AccountBadge, accountColors } from "./provider-account-icon.tsx";
import { accountBadgeIcons } from "./account-badge-icons.ts";

export function accountBadgeProblem(value: string): string | undefined {
  return !value.trim() || AccountBadgeInput.safeParse(value.trim()).success
    ? undefined
    : "Use up to two letters, or pick an icon.";
}

type BadgeProps = {
  provider: ProviderKind;
  value: string;
  onChange(value: string): void;
  name?: string | undefined;
  color?: AccountBadgeColor | undefined;
  onColorChange?: ((color: AccountBadgeColor) => void) | undefined;
  /** A curated icon in place of the letters; undefined shows the letters. */
  icon?: AccountBadgeIcon | undefined;
  onIconChange?: ((icon: AccountBadgeIcon | undefined) => void) | undefined;
};

/** A short account mark: up to two letters, or an icon from the curated set, plus its colour. */
export function AccountBadgeField(props: BadgeProps) {
  const id = useId();
  const help = useId();
  const issue = accountBadgeProblem(props.value);
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm text-muted-foreground">
          Badge
        </label>
        <Input
          id={id}
          aria-label="Short label"
          aria-describedby={help}
          aria-invalid={!!issue}
          value={props.value}
          onChange={(event) => {
            props.onChange(event.target.value);
            props.onIconChange?.(undefined);
          }}
          className="h-8 w-16 text-center"
        />
        <AccountBadge
          colorPreview
          account={{
            label: props.name ?? "Account",
            shortLabel: issue ? "?" : props.value,
            badgeColor: props.color,
            badgeIcon: props.icon,
          }}
        />
      </div>
      <p
        id={help}
        className={issue ? "text-xs text-destructive" : "text-xs text-subtle-foreground"}
      >
        {issue ?? "Up to two letters, or pick an icon."}
      </p>
      <BadgeColours {...props} />
      {props.onIconChange && <BadgeIcons {...props} />}
    </div>
  );
}

function BadgeIcons(props: BadgeProps) {
  return (
    <div role="group" aria-label="Badge icons" className="flex flex-wrap gap-1">
      <Tip label="Use letters">
        <Button
          size="sm"
          variant={props.icon ? "ghost" : "secondary"}
          className="size-8 px-0"
          aria-label="Use letters"
          aria-pressed={!props.icon}
          onClick={() => props.onIconChange?.(undefined)}
        >
          <TextAaIcon aria-hidden size={16} />
        </Button>
      </Tip>
      {accountBadgeIcons.map(({ icon, label, glyph: Glyph }) => (
        <Tip key={icon} label={`Use ${label.toLowerCase()} badge`}>
          <Button
            size="sm"
            variant={props.icon === icon ? "secondary" : "ghost"}
            className="size-8 px-0"
            aria-label={`Use ${label.toLowerCase()} badge`}
            aria-pressed={props.icon === icon}
            onClick={() => props.onIconChange?.(icon)}
          >
            <Glyph aria-hidden size={16} />
          </Button>
        </Tip>
      ))}
    </div>
  );
}

function BadgeColours(props: BadgeProps) {
  return (
    props.onColorChange && (
      <div role="group" aria-label="Badge colours" className="flex gap-2">
        {AccountBadgeColor.options.map((color) => (
          <Tip key={color} label={`Use ${color} badge`}>
            <button
              type="button"
              aria-label={`Use ${color} badge`}
              aria-pressed={props.color === color}
              onClick={() => props.onColorChange?.(color)}
              className="rounded-full p-1 focus-ring hover:bg-accent active:bg-accent"
              style={{
                color: accountColors[color],
                outline: props.color === color ? "1px solid currentColor" : undefined,
              }}
            >
              <AccountBadge
                colorPreview
                decorative
                account={{
                  label: props.name ?? "Account",
                  shortLabel: props.value,
                  badgeColor: color,
                  badgeIcon: props.icon,
                }}
              />
            </button>
          </Tip>
        ))}
      </div>
    )
  );
}

/** Compact initial-first chooser for adding an account. */
export function AccountBadgeChooser(props: BadgeProps) {
  return (
    <div className="grid gap-2 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Badge</span>
        <BadgeColours {...props} />
      </div>
      <Disclosure summary="Letters or an icon" summaryClassName="text-xs">
        <div className="pt-2">
          <AccountBadgeField {...props} onColorChange={undefined} />
        </div>
      </Disclosure>
    </div>
  );
}
