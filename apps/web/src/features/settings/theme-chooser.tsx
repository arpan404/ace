import type { CSSProperties } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { cn } from "@/lib/cn.ts";
import { themedPalette, type AccentChoice } from "@/theme/accent.ts";
import { themeIds, themes, type Scheme, type ThemeId } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { pickerCard } from "./mode-picker.tsx";

/**
 * One scheme of a theme as a tile, painted from its real palette with the accent in use: the
 * canvas underneath, a light falling from the raised and surface steps, the accent pooling in
 * the far corner, and "Aa" in the theme's text colour and transcript face (Folio's serif, Tty's
 * monospace), beside its working and done dots.
 */
function SchemeSwatch(props: { id: ThemeId; scheme: Scheme; accent: AccentChoice }) {
  const p = themedPalette(props.id, props.scheme, props.accent);
  const style = {
    backgroundColor: p.s0,
    backgroundImage: [
      `radial-gradient(120% 110% at 22% 12%, ${p.s2} 0%, ${p.s1} 38%, transparent 72%)`,
      `radial-gradient(75% 75% at 92% 100%, color-mix(in srgb, ${p.accent} 34%, transparent), transparent 70%)`,
    ].join(", "),
    boxShadow: [
      `inset 0 0 0 1px ${p.border}`,
      `inset 0 1px 0 color-mix(in srgb, ${p.s2} 70%, transparent)`,
      `0 8px 18px -10px rgb(${p.shadow} / 0.55)`,
    ].join(", "),
  } satisfies CSSProperties;
  return (
    <span
      data-swatch={props.scheme}
      style={style}
      className="relative flex size-18 flex-col justify-between rounded-2xl p-2"
    >
      <span
        style={{ color: p.t1, fontFamily: themes[props.id].fonts.prose }}
        className="text-sm leading-none"
      >
        Aa
      </span>
      <span className="flex gap-1">
        <i style={{ background: p.working }} className="size-1.5 rounded-full" />
        <i style={{ background: p.done }} className="size-1.5 rounded-full" />
        <i style={{ background: p.accent }} className="ml-auto size-1.5 rounded-full" />
      </span>
    </span>
  );
}

/** The sun or moon on the swatch of the scheme the app is showing now. */
function SchemeBadge(props: { scheme: Scheme }) {
  const Icon = props.scheme === "dark" ? MoonIcon : SunIcon;
  return (
    <span
      data-badge={props.scheme}
      className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-border bg-popover text-foreground"
    >
      <Icon weight="fill" className="size-3" />
    </span>
  );
}

/** Every theme as a card: its light and dark identity side by side, the name beneath. */
export function ThemeChooser() {
  const { appearance, update, resolved } = useTheme();
  const accent = { accent: appearance.accent, customAccent: appearance.customAccent };
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onRadioKeys}
      className="grid grid-cols-1 gap-3 @min-[360px]:grid-cols-2 @min-[620px]:grid-cols-3"
    >
      {themeIds.map((id) => {
        const checked = appearance.theme === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={themes[id].name}
            aria-description={themes[id].character}
            tabIndex={checked ? 0 : -1}
            onClick={() => update({ theme: id })}
            className={cn(pickerCard, "gap-3 p-3")}
          >
            <span aria-hidden className="flex justify-center gap-3 pt-3 pb-1">
              {(["light", "dark"] as const).map((scheme) => (
                <span key={scheme} className="relative">
                  <SchemeSwatch id={id} scheme={scheme} accent={accent} />
                  {checked && resolved.scheme === scheme && <SchemeBadge scheme={scheme} />}
                </span>
              ))}
            </span>
            <span
              aria-hidden
              style={{ fontFamily: themes[id].fonts.ui }}
              className="truncate px-0.5 text-sm text-muted-foreground group-aria-checked:font-medium group-aria-checked:text-foreground"
            >
              {themes[id].name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
