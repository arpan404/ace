import type { CSSProperties } from "react";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { cn } from "@/lib/cn.ts";
import { rampSteps, themeIds, themes, type Scheme, type ThemeId } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";

const rampStrip = {
  gridTemplateColumns: `repeat(${rampSteps.length}, 1fr)`,
} satisfies CSSProperties;

/** A sidebar task row in miniature: its status dot and title, the selected one filled. */
function Row(props: { status: string; selected?: boolean }) {
  return (
    <span
      className={cn("flex items-center gap-1 rounded-xs px-1 py-[3px]", {
        "bg-active": props.selected,
      })}
    >
      <i className={cn("size-[5px] shrink-0 rounded-full", props.status)} />
      <i
        className={cn(
          "h-[3px] flex-1 rounded-xs",
          props.selected ? "bg-foreground/80" : "bg-subtle-foreground/70",
        )}
      />
    </span>
  );
}

/**
 * One scheme of a theme in miniature, drawn with the theme's real tokens: the two attributes
 * scope them to this element as `<html>` does for the app. The sidebar with a task in each
 * status (the selected one filled), a user bubble and an answer in the text greys, the composer
 * with its Send disc in the accent, and the twelve-step neutral ramp along the bottom.
 */
function ThemeHalf(props: { id: ThemeId; scheme: Scheme }) {
  return (
    <span
      data-theme={props.id}
      data-scheme={props.scheme}
      className="flex min-w-0 flex-col bg-background"
    >
      <span className="grid min-h-0 flex-1 grid-cols-[34%_1fr]">
        <span className="flex flex-col gap-px border-r border-border bg-sidebar px-1 py-1.5">
          <Row status="bg-status-needs-you" />
          <Row status="bg-status-working" selected />
          <Row status="bg-status-done" />
          <Row status="bg-status-failed" />
        </span>
        <span className="flex min-w-0 flex-col gap-1 px-1.5 pt-1.5">
          <i className="ml-auto h-2 w-3/5 rounded-xs bg-bubble" />
          <i className="h-[3px] w-4/5 rounded-xs bg-foreground" />
          <i className="h-[3px] w-3/5 rounded-xs bg-muted-foreground" />
          <span className="mt-auto mb-1 flex items-center gap-1 rounded-xs border border-border-strong bg-popover py-[3px] pr-[3px] pl-1.5">
            <i className="h-[3px] flex-1 rounded-xs bg-subtle-foreground" />
            <i className="size-2 shrink-0 rounded-full bg-tint" />
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
      className="grid grid-cols-2 gap-2 @min-[480px]:grid-cols-3"
    >
      {themeIds.map((id) => {
        const checked = appearance.theme === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-description={themes[id].character}
            tabIndex={checked ? 0 : -1}
            onClick={() => update({ theme: id })}
            className="group flex min-w-0 flex-col gap-1.5 rounded-lg p-1.5 text-left outline-none transition-colors duration-(--motion-fast) hover:bg-fill"
          >
            <span
              aria-hidden
              className="grid h-(--theme-preview-height) grid-cols-2 overflow-hidden rounded-sm shadow-[0_0_0_1px_var(--border)] transition-shadow duration-(--motion-base) group-aria-checked:shadow-[0_0_0_2px_var(--ring),0_0_0_4px_color-mix(in_srgb,var(--ring)_22%,transparent)] group-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]"
            >
              <ThemeHalf id={id} scheme="light" />
              <ThemeHalf id={id} scheme="dark" />
            </span>
            <span
              style={{ fontFamily: themes[id].fonts.ui }}
              className="truncate pl-0.5 text-sm text-muted-foreground group-aria-checked:font-medium group-aria-checked:text-foreground"
            >
              {themes[id].name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
