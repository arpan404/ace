import { useState } from "react";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { Input } from "@/components/ui/input.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import {
  accentColour,
  accentIds,
  accentNames,
  themedPalette,
  type AccentId,
} from "@/theme/accent.ts";
import { nearStatus } from "@/theme/accent-fit.ts";
import { themes } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";

const swatch =
  "relative size-7 shrink-0 rounded-full outline-none transition-[box-shadow,translate] duration-(--motion-fast) motion-safe:hover:-translate-y-px shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.25)] aria-checked:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)] focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]";
/** The same light from the top-left corner as the theme tiles. */
const gloss = "radial-gradient(circle at 32% 26%, rgb(255 255 255 / 0.32), transparent 62%)";
const hexPattern = /^#[0-9a-f]{6}$/i;

/**
 * The accent, laid over whichever theme is on: the theme's own, six curated colours, Ink (the
 * text colour) or a custom colour. Each swatch shows the colour as it will look, fitted to the
 * current theme and scheme.
 */
export function AccentPicker() {
  const { appearance, update, resolved } = useTheme();
  const choice = { accent: appearance.accent, customAccent: appearance.customAccent };
  const [hex, setHex] = useState(appearance.customAccent);
  const fitted = (accent: AccentId) =>
    themedPalette(resolved.theme, resolved.scheme, { ...choice, accent }).accent;
  const custom = appearance.accent === "custom";
  const moved =
    custom &&
    nearStatus(
      accentColour(resolved.theme, resolved.scheme, choice),
      resolved.scheme,
      themes[resolved.theme][resolved.scheme],
    );
  const setCustom = (value: string) => {
    setHex(value);
    if (hexPattern.test(value)) update({ accent: "custom", customAccent: value.toUpperCase() });
  };
  return (
    <div className="flex flex-col items-start gap-3">
      <div
        role="radiogroup"
        aria-label="Accent"
        onKeyDown={onRadioKeys}
        className="flex flex-wrap items-center gap-2.5 px-0.5"
      >
        {accentIds.map((id) => {
          const checked = appearance.accent === id;
          const label = id === "theme" ? `${themes[resolved.theme].name} default` : accentNames[id];
          if (id === "custom")
            return (
              <Tip key={id} label={`Custom (${appearance.customAccent})`}>
                <label
                  className={cn(
                    swatch,
                    "overflow-hidden bg-[conic-gradient(#E5484D,#E8A33D,#46A758,#3E9BD6,#8E4EC6,#E5484D)] has-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]",
                    checked && "shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)]",
                  )}
                >
                  <input
                    type="color"
                    role="radio"
                    aria-checked={checked}
                    aria-label="Custom accent"
                    tabIndex={checked ? 0 : -1}
                    value={appearance.customAccent.toLowerCase()}
                    onClick={() => !checked && update({ accent: "custom" })}
                    onChange={(event) => setCustom(event.target.value)}
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                  />
                </label>
              </Tip>
            );
          return (
            <Tip key={id} label={label}>
              <button
                type="button"
                role="radio"
                aria-label={label}
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                onClick={() => update({ accent: id })}
                className={swatch}
                style={{ backgroundColor: fitted(id), backgroundImage: gloss }}
              >
                {id === "theme" && (
                  <span aria-hidden className="absolute inset-2 rounded-full bg-background/90" />
                )}
              </button>
            </Tip>
          );
        })}
      </div>
      {custom && (
        <div className="flex items-center gap-2">
          {moved && (
            <span className="text-xs text-muted-foreground">
              Shifted to stay clear of status colours
            </span>
          )}
          <Input
            aria-label="Custom accent hex"
            aria-invalid={!hexPattern.test(hex)}
            maxLength={7}
            spellCheck={false}
            value={hex}
            onChange={(event) => setCustom(event.target.value.trim())}
            className="h-7 w-24 font-mono text-xs uppercase"
          />
        </div>
      )}
    </div>
  );
}
