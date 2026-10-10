import { AccountBadgeInput, AccountBadgeColor } from "@ace/protocol/accounts";
import type { ProviderKind } from "@ace/protocol";
import { useId } from "react";
import { Input } from "./input.tsx";
import { Button } from "./button.tsx";
import { AccountBadge, accountColors } from "./provider-account-icon.tsx";

const symbols = ["💼", "🏠", "🧪", "🚀", "🌙", "🔧"];

export function accountBadgeProblem(value: string): string | undefined {
  return !value.trim() || AccountBadgeInput.safeParse(value.trim()).success
    ? undefined
    : "Use up to two characters or one emoji.";
}

/** A short account mark, with Unicode input kept intact and validation shared with the daemon. */
export function AccountBadgeField(props: {
  provider: ProviderKind;
  value: string;
  onChange(value: string): void;
  name?: string | undefined;
  color?: AccountBadgeColor | undefined;
  onColorChange?(color: AccountBadgeColor): void;
}) {
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
          onChange={(event) => props.onChange(event.target.value)}
          className="h-8 w-16 text-center"
        />
        <AccountBadge
          account={{
            label: props.name ?? "Account",
            shortLabel: issue ? "?" : props.value,
            badgeColor: props.color,
          }}
        />
      </div>
      <p
        id={help}
        className={issue ? "text-xs text-destructive" : "text-xs text-subtle-foreground"}
      >
        {issue ?? "Up to two characters, or one emoji."}
      </p>
      <BadgeColours {...props} />
      <div role="group" aria-label="Badge icons" className="flex flex-wrap gap-1">
        {symbols.map((symbol) => (
          <Button
            key={symbol}
            size="sm"
            variant="ghost"
            aria-label={`Use ${symbol} badge`}
            aria-pressed={props.value === symbol}
            onClick={() => props.onChange(symbol)}
          >
            {symbol}
          </Button>
        ))}
      </div>
    </div>
  );
}

function BadgeColours(props: {
  value: string;
  name?: string | undefined;
  color?: AccountBadgeColor | undefined;
  onColorChange?(color: AccountBadgeColor): void;
}) {
  return (
    props.onColorChange && (
      <div role="group" aria-label="Badge colours" className="flex gap-2">
        {AccountBadgeColor.options.map((color) => (
          <button
            type="button"
            key={color}
            aria-label={`Use ${color} badge`}
            aria-pressed={props.color === color}
            onClick={() => props.onColorChange?.(color)}
            className="rounded-full p-1 focus-ring aria-pressed:ring-1"
            style={{ color: accountColors[color] }}
          >
            <AccountBadge
              decorative
              account={{
                label: props.name ?? "Account",
                shortLabel: props.value,
                badgeColor: color,
              }}
            />
          </button>
        ))}
      </div>
    )
  );
}

/** Compact initial-first chooser for adding an account. */
export function AccountBadgeChooser(props: Parameters<typeof AccountBadgeField>[0]) {
  return (
    <div className="grid gap-2 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Badge</span>
        <BadgeColours {...props} />
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-subtle-foreground focus-ring">
          Or use an emoji…
        </summary>
        <div className="pt-2">
          <AccountBadgeField
            provider={props.provider}
            value={props.value}
            onChange={props.onChange}
            name={props.name}
            color={props.color}
          />
        </div>
      </details>
    </div>
  );
}
