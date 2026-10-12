import type { CSSProperties } from "react";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { rampSteps, themeIds, themes, type Scheme, type ThemeId } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";

const rampStrip = {
  gridTemplateColumns: `repeat(${rampSteps.length}, 1fr)`,
} satisfies CSSProperties;

/**
 * One scheme of a theme in miniature, drawn with the theme's real tokens: the two attributes
 * scope them to this element as `<html>` does for the app. A sidebar, text in its three greys, a
 * raised card with the accent, and the twelve-step neutral ramp along the bottom.
 */
function ThemeHalf(props: { id: ThemeId; scheme: Scheme }) {
  return (
    <span
      data-theme={props.id}
      data-scheme={props.scheme}
      className="flex min-w-0 flex-col bg-background"
    >
      <span className="grid min-h-0 flex-1 grid-cols-[26%_1fr]">
        <span className="flex flex-col gap-1.5 border-r border-border bg-sidebar px-1.5 py-2">
          <i className="h-[3px] rounded-xs bg-foreground/70" />
          <i className="h-[3px] rounded-xs bg-subtle-foreground/70" />
          <i className="h-[3px] rounded-xs bg-subtle-foreground/70" />
        </span>
        <span className="flex min-w-0 flex-col gap-1.5 px-2 pt-2">
          <i className="h-[3px] w-4/5 rounded-xs bg-foreground" />
          <i className="h-[3px] w-3/5 rounded-xs bg-muted-foreground" />
          <span className="mt-auto mb-1.5 flex items-center gap-1.5 rounded-sm border border-border bg-popover px-1.5 py-1">
            <i className="h-[3px] flex-1 rounded-xs bg-subtle-foreground" />
            <i className="h-2 w-4 shrink-0 rounded-full bg-tint" />
          </span>
        </span>
      </span>
      <span className="grid h-1.5 shrink-0" style={rampStrip}>
        {rampSteps.map((step, index) => (
          <i key={step} style={{ background: `var(--neutral-${index + 1})` }} />
        ))}
      </span>
    </span>
  );
}

/** Every theme as a swatch card, previewing its light and dark palettes side by side. */
export function ThemeChooser() {
  const { appearance, update } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onRadioKeys}
      className="grid grid-cols-2 gap-2 @min-[560px]:grid-cols-4"
    >
      {themeIds.map((id) => {
        const checked = appearance.theme === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => update({ theme: id })}
            className="group flex min-w-0 flex-col gap-1.5 rounded-lg p-1.5 text-left outline-none transition-colors duration-(--motion-fast) hover:bg-fill"
          >
            <span
              aria-hidden
              className="grid h-[76px] grid-cols-2 overflow-hidden rounded-sm shadow-[0_0_0_1px_var(--border)] transition-shadow duration-(--motion-base) group-aria-checked:shadow-[0_0_0_2px_var(--ring),0_0_0_4px_color-mix(in_srgb,var(--ring)_22%,transparent)] group-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]"
            >
              <ThemeHalf id={id} scheme="light" />
              <ThemeHalf id={id} scheme="dark" />
            </span>
            <span className="truncate pl-0.5 text-sm text-muted-foreground group-aria-checked:font-medium group-aria-checked:text-foreground">
              {themes[id].name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
