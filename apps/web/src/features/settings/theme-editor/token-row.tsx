import { SettingRow } from "@/components/setting-row.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
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
  "h-7 min-w-0 w-40 max-w-full rounded-sm bg-secondary px-2 font-mono text-sm text-foreground focus-ring";

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
    <SettingRow
      title={
        <Tip label={token}>
          <span tabIndex={0} className="rounded-sm focus-ring">
            {label}
          </span>
        </Tip>
      }
      inline
    >
      <div className="flex flex-wrap justify-end gap-2">
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
            className="size-7 shrink-0 overflow-hidden rounded-sm border border-foreground/30"
            style={{ background: "repeating-conic-gradient(#ddd 0% 25%, #777 0% 50%) 0 / 8px 8px" }}
          >
            <span className="block size-full" style={swatch ? { background: swatch } : undefined} />
          </span>
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
          className={field}
        />
      </div>
      {!valid && (
        <p id={errorId} className="mt-1 text-xs text-destructive">
          {tokenKindHints[kind]}
        </p>
      )}
    </SettingRow>
  );
});
