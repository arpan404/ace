import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { themeIds, themes, type Scheme, type ThemeId } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";

/**
 * One scheme of a theme in miniature: sidebar, text lines, a working line and an accent pill.
 * The two attributes scope the theme's real tokens to this element, as `<html>` does for the app.
 */
function ThemeHalf(props: { id: ThemeId; scheme: Scheme }) {
  return (
    <span
      data-theme={props.id}
      data-scheme={props.scheme}
      className="grid grid-cols-[30%_1fr] bg-background"
    >
      <span className="flex flex-col gap-[5px] border-r border-border bg-sidebar px-[5px] py-2">
        <i className="h-[3px] rounded-[2px] bg-subtle-foreground/55" />
        <i className="h-[3px] rounded-[2px] bg-subtle-foreground/55" />
        <i className="h-[3px] rounded-[2px] bg-subtle-foreground/55" />
      </span>
      <span className="flex flex-col gap-[5px] px-2 py-2.5">
        <i className="h-[3px] w-4/5 rounded-[2px] bg-foreground/85" />
        <i className="h-[3px] w-3/5 rounded-[2px] bg-subtle-foreground/55" />
        <i className="h-[3px] w-[30px] rounded-[2px] bg-status-working" />
        <i className="mt-auto h-2.5 w-[22px] self-end rounded-full bg-tint" />
      </span>
    </span>
  );
}

/** The six themes as swatch cards, each previewing its light and dark palettes side by side. */
export function ThemeChooser() {
  const { appearance, update } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onRadioKeys}
      className="grid grid-cols-2 gap-3 @min-[480px]:grid-cols-3"
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
            className="group flex min-w-0 flex-col gap-2 rounded-lg px-1.5 pt-1.5 pb-2 text-left outline-none transition-colors duration-(--motion-fast) hover:bg-fill"
          >
            <span
              aria-hidden
              className="grid h-[72px] grid-cols-2 overflow-hidden rounded-sm shadow-[0_0_0_1px_var(--border)] transition-shadow duration-(--motion-base) group-aria-checked:shadow-[0_0_0_2px_var(--ring),0_0_0_4px_color-mix(in_srgb,var(--ring)_22%,transparent)] group-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]"
            >
              <ThemeHalf id={id} scheme="light" />
              <ThemeHalf id={id} scheme="dark" />
            </span>
            <span className="truncate pl-0.5 text-sm group-aria-checked:font-medium">
              {themes[id].name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
