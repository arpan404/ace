import { memo } from "react";
import { tokenHints, type TokenName } from "@/theme/tokens.ts";
import { isHexColor, longHex, swatchColor } from "./editor-model.ts";

const input =
  "h-7 w-full min-w-0 rounded-[7px] bg-secondary px-2 font-mono text-[12px] text-foreground outline-none transition-shadow duration-150 focus:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_40%,transparent)]";

/** One token: name, swatch, value field and, for hex colours, a native colour picker. */
export const TokenRow = memo(function TokenRow(props: {
  token: TokenName;
  value: string;
  warning: boolean;
  onChange(token: TokenName, value: string): void;
}) {
  const { token, value } = props;
  const swatch = swatchColor(value);
  const hint = tokenHints[token];
  const inputId = `token-${token.slice(2)}`;
  return (
    <div className="border-t">
      <div className="grid h-9 grid-cols-[200px_22px_minmax(0,1fr)_30px] items-center gap-2.5">
        <label
          htmlFor={inputId}
          className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground"
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
        <span
          aria-hidden
          className="size-[22px] rounded-sm shadow-[inset_0_0_0_1px_var(--border)]"
          style={swatch ? { background: swatch } : undefined}
        />
        <input
          id={inputId}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => props.onChange(token, event.target.value)}
          className={input}
        />
        {isHexColor(value) ? (
          <input
            type="color"
            aria-label={`Pick ${token}`}
            value={longHex(value)}
            onChange={(event) => props.onChange(token, event.target.value.toUpperCase())}
            className="h-7 w-[30px] cursor-pointer border-0 bg-transparent p-0 opacity-90 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0.5"
          />
        ) : (
          <span aria-hidden />
        )}
      </div>
      {hint && (
        <p className="-mt-1 mb-1.5 ml-[210px] text-[11.5px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
});
