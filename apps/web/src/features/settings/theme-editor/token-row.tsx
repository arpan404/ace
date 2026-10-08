import { memo, useEffect, useRef, useState } from "react";
import {
  isValidTokenValue,
  tokenLabels,
  tokenKind,
  tokenKindHints,
  type TokenName,
} from "@/theme/tokens.ts";
import { isHexColor, longHex, swatchColor } from "./editor-model.ts";

/** How long typing pauses before a valid value applies; leaving the field applies at once. */
const settleMs = 150;

const field =
  "h-7 min-w-0 w-full rounded-sm bg-secondary px-2 font-mono text-sm text-foreground focus-ring";

/**
 * One token: name, a swatch that is also the colour picker for hex values, and the value
 * field. The field is a draft: a value CSS would refuse ("#1", "banana") is marked and never
 * applied or stored; the last valid value stays on screen.
 */
export const TokenRow = memo(function TokenRow(props: {
  token: TokenName;
  value: string;
  warning: boolean;
  onChange(token: TokenName, value: string): void;
}) {
  const { token, value, onChange } = props;
  const kind = tokenKind(token);
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  // The theme changed under the field (reset, another theme): show its value.
  if (value !== shown) {
    setShown(value);
    setDraft(value);
  }
  const valid = isValidTokenValue(kind, draft);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (next: string) => {
    clearTimeout(timer.current);
    if (next.trim() !== value && isValidTokenValue(kind, next)) onChange(token, next.trim());
  };
  const swatch = swatchColor(valid ? draft : value);
  const label = tokenLabels[token];
  const inputId = `token-${token.slice(2)}`;
  const errorId = `${inputId}-error`;
  return (
    <div className="border-t py-1">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,2fr)]">
        <label htmlFor={inputId} className="min-w-0 flex-1 text-sm leading-4">
          <span className="block truncate">{label}</span>
          <span className="block truncate font-mono text-xs leading-3 text-muted-foreground">
            {token}
          </span>
          {props.warning && (
            <span
              className="size-1.5 rounded-full bg-status-failed"
              aria-label="Low contrast"
              role="img"
            />
          )}
        </label>
        {isHexColor(value) ? (
          <input
            type="color"
            aria-label={`Pick ${label}`}
            value={longHex(value)}
            onChange={(event) => onChange(token, event.target.value.toUpperCase())}
            className="size-7 shrink-0 cursor-pointer rounded-sm border border-foreground/30 bg-transparent p-0 focus-ring [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
          />
        ) : (
          <span
            aria-hidden
            className="size-7 shrink-0 rounded-sm border border-foreground/30"
            style={swatch ? { background: swatch } : undefined}
          />
        )}
        <input
          id={inputId}
          aria-label={label}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!valid}
          style={
            valid
              ? undefined
              : { boxShadow: "0 0 0 2px var(--background), 0 0 0 4px var(--destructive)" }
          }
          aria-describedby={valid ? undefined : errorId}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => commit(next), settleMs);
          }}
          onBlur={() => commit(draft)}
          className={`${field} col-span-2 sm:col-span-1`}
        />
      </div>
      {!valid && (
        <p id={errorId} className="mt-1 text-xs text-destructive">
          {tokenKindHints[kind]}
        </p>
      )}
    </div>
  );
});
