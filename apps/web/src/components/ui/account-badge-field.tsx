import { AccountBadgeInput } from "@ace/protocol/accounts";
import type { ProviderKind } from "@ace/protocol";
import { useId, type CSSProperties } from "react";
import { Input } from "./input.tsx";
import { Button } from "./button.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { accountBadge, accountBadgeStyle } from "./account-badge.ts";

const symbols = ["💼", "🏠", "🧪", "🚀", "🌙", "🔧"];

export function accountBadgeProblem(value: string): string | undefined {
  return AccountBadgeInput.safeParse(value.trim()).success
    ? undefined
    : "Use up to two characters or one emoji.";
}

/** A short account mark, with Unicode input kept intact and validation shared with the daemon. */
export function AccountBadgeField(props: {
  provider: ProviderKind;
  value: string;
  onChange(value: string): void;
  name?: string;
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
        <span
          className="inline-flex items-center gap-1 rounded-sm bg-secondary px-2 py-1 text-xs"
          title={props.name}
          aria-label={`Account badge preview${props.name ? ` for ${props.name}` : ""}`}
        >
          <span
            className="inline-flex items-center gap-0.5"
            style={{ "--account-color": "var(--foreground)" } as CSSProperties}
          >
            <ProviderIcon provider={props.provider} size={12} decorative />
            <span className={accountBadgeStyle}>
              {issue ? "?" : accountBadge(props.name ?? "Account", props.value)}
            </span>
          </span>
        </span>
      </div>
      <p
        id={help}
        className={issue ? "text-xs text-destructive" : "text-xs text-subtle-foreground"}
      >
        {issue ?? "Up to two characters, or one emoji."}
      </p>
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
