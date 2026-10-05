import { memo, useEffect, useRef, useState } from "react";
import {
  isValidTokenValue,
  tokenHints,
  tokenKind,
  tokenKindHints,
  type TokenName,
} from "@/theme/tokens.ts";
import { isHexColor, longHex, swatchColor } from "./editor-model.ts";

/** How long typing pauses before a valid value applies; leaving the field applies at once. */
const settleMs = 150;

const field =
  "h-7 w-full min-w-0 rounded-sm bg-secondary px-2 font-mono text-sm text-foreground focus-ring aria-invalid:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--destructive)]";

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
  const hint = tokenHints[token];
  const inputId = `token-${token.slice(2)}`;
  const errorId = `${inputId}-error`;
  return (
    <div className="border-t py-1.5">
      <div className="grid grid-cols-[22px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1 sm:grid-cols-[200px_22px_minmax(0,1fr)]">
        <label
          htmlFor={inputId}
          className="col-span-2 flex items-center gap-1.5 font-mono text-sm text-muted-foreground sm:col-span-1"
        >
          {token}
          {props.warning && (
            <span
              className="size-1.5 rounded-full bg-status-needs-you"
              aria-label="Low contrast"
              role="img"
            />
          )}
        </label>
        {isHexColor(value) ? (
          <input
            type="color"
            aria-label={`Pick ${token}`}
            value={longHex(value)}
            onChange={(event) => onChange(token, event.target.value.toUpperCase())}
            className="size-[22px] cursor-pointer rounded-sm border-0 bg-transparent p-0 shadow-[inset_0_0_0_1px_var(--border)] focus-ring [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
          />
        ) : (
          <span
            aria-hidden
            className="size-[22px] rounded-sm shadow-[inset_0_0_0_1px_var(--border)]"
            style={swatch ? { background: swatch } : undefined}
          />
        )}
        <input
          id={inputId}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!valid}
          aria-describedby={valid ? undefined : errorId}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => commit(next), settleMs);
          }}
          onBlur={() => commit(draft)}
          className={field}
        />
      </div>
      {!valid && (
        <p id={errorId} className="mt-1 text-xs text-destructive sm:ml-[242px]">
          {tokenKindHints[kind]}
        </p>
      )}
      {hint && <p className="mt-1 text-xs text-muted-foreground sm:ml-[242px]">{hint}</p>}
    </div>
  );
});
