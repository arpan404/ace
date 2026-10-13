import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { cn } from "@/lib/cn.ts";
import type { Mode } from "@/theme/appearance.ts";
import type { Scheme, ThemeId } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";

const modes: { value: Mode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** A shared card shell for the mode and theme pickers: solid, roomy, ringed when chosen. */
export const pickerCard =
  "group relative flex min-w-0 flex-col rounded-card border border-border bg-card text-left outline-none transition-[translate,box-shadow,border-color] duration-(--motion-base) hover:border-border-strong motion-safe:hover:-translate-y-0.5 hover:shadow-raised aria-checked:border-ring aria-checked:shadow-[0_0_0_1px_var(--ring)] focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]";

/**
 * The app in miniature, in one scheme of the current theme: its tokens scoped to this element as
 * `<html>` scopes them for the app. A sidebar of tasks (one selected), a user bubble and an
 * answer, and the composer pill with its Send disc in the accent.
 */
function AppMock(props: { theme: ThemeId; scheme: Scheme; className?: string }) {
  return (
    <span
      data-theme={props.theme}
      data-scheme={props.scheme}
      className={cn("absolute inset-0 grid grid-cols-[30%_1fr] bg-background", props.className)}
    >
      <span className="flex flex-col gap-1 border-r border-border bg-sidebar px-1.5 py-2">
        <i className="mb-1 h-1 w-1/2 rounded-full bg-foreground/70" />
        <MockRow status="bg-status-working" selected />
        <MockRow status="bg-status-needs-you" />
        <MockRow status="bg-status-done" />
      </span>
      <span className="flex min-w-0 flex-col gap-1.5 px-2.5 pt-2.5 pb-2">
        <i className="ml-auto h-2.5 w-1/2 rounded-full bg-bubble" />
        <i className="h-1 w-4/5 rounded-full bg-foreground/80" />
        <i className="h-1 w-3/5 rounded-full bg-muted-foreground/60" />
        <span className="mt-auto flex items-center gap-1.5 rounded-full border border-border-strong bg-popover py-1 pr-1 pl-2.5">
          <i className="h-1 flex-1 rounded-full bg-subtle-foreground/50" />
          <i className="size-2.5 shrink-0 rounded-full bg-tint" />
        </span>
      </span>
    </span>
  );
}

function MockRow(props: { status: string; selected?: boolean }) {
  return (
    <span
      className={cn("flex items-center gap-1 rounded-xs px-1 py-1", props.selected && "bg-active")}
    >
      <i className={cn("size-1 shrink-0 rounded-full", props.status)} />
      <i
        className={cn(
          "h-1 flex-1 rounded-full",
          props.selected ? "bg-foreground/70" : "bg-subtle-foreground/50",
        )}
      />
    </span>
  );
}

/** System, Light and Dark as cards, each previewing the current theme as it will look. */
export function ModePicker() {
  const { appearance, update, resolved } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      onKeyDown={onRadioKeys}
      className="grid grid-cols-3 gap-2 @min-[420px]:gap-3"
    >
      {modes.map(({ value, label }) => {
        const checked = appearance.mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            tabIndex={checked ? 0 : -1}
            onClick={() => update({ mode: value })}
            className={cn(pickerCard, "gap-1.5 p-1.5 @min-[420px]:gap-2 @min-[420px]:p-2")}
          >
            <span
              aria-hidden
              className="relative block aspect-[16/10] overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--border)]"
            >
              <AppMock theme={resolved.theme} scheme={value === "dark" ? "dark" : "light"} />
              {value === "system" && (
                <AppMock
                  theme={resolved.theme}
                  scheme="dark"
                  className="[clip-path:polygon(62%_0,100%_0,100%_100%,38%_100%)]"
                />
              )}
            </span>
            <span
              aria-hidden
              className="px-1 pb-0.5 text-sm text-muted-foreground group-aria-checked:font-medium group-aria-checked:text-foreground"
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
