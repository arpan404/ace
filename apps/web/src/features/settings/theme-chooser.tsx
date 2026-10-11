import { CheckIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import type { Theme } from "@/theme/presets.ts";

/** Real preset and custom tokens, scoped like the app; derived materials are resolved locally. */
function ThemeSample(props: { theme: Theme }) {
  const t = props.theme.tokens;
  const style: CSSProperties & Record<string, string> = {
    "--sidebar": `rgb(${t["--sidebar-rgb"]})`,
    "--reading": `rgb(${t["--reading-rgb"]})`,
    "--ring": t["--accent-theme"],
    "--ring-foreground": t["--primary-foreground"],
    colorScheme: props.theme.scheme,
  };
  return (
    <span
      aria-hidden
      data-theme={props.theme.id}
      style={style}
      className="flex h-(--theme-preview-height) min-w-0 flex-1 overflow-hidden rounded-md border bg-reading text-foreground"
    >
      <span className="flex w-1/4 flex-col gap-2 bg-sidebar p-2">
        <span className="h-1.5 w-3/4 rounded-full bg-foreground/50" />
        <span className="h-1.5 rounded-full bg-tint" />
        <span className="h-1.5 w-2/3 rounded-full bg-foreground/20" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2 p-2">
        <span className="ml-auto h-4 w-3/4 rounded-md bg-bubble" />
        <span className="h-1.5 w-4/5 rounded-full bg-foreground/60" />
        <span className="h-1.5 w-1/2 rounded-full bg-foreground/20" />
        <span className="mt-auto flex h-5 items-center justify-end rounded-md border bg-popover px-1">
          <span className="size-3 rounded-full bg-tint" />
        </span>
      </span>
    </span>
  );
}

export function ThemeChooser() {
  const { appearance, update, themes } = useTheme();
  const system = themes.filter((theme) => theme.id === "light" || theme.id === "dark");
  const options = [
    { id: "system", name: "System", previews: system },
    ...themes.map((theme) => ({ id: theme.id, name: theme.name, previews: [theme] })),
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onRadioKeys}
      className="grid grid-cols-2 gap-3 py-(--setting-row-padding) @min-[560px]:grid-cols-3"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-label={option.name}
          aria-checked={appearance.theme === option.id}
          tabIndex={appearance.theme === option.id ? 0 : -1}
          onClick={() => update({ theme: option.id })}
          className="focus-ring min-w-0 rounded-lg border p-2 text-left aria-checked:border-ring aria-checked:bg-accent hover:bg-accent"
        >
          <span className="flex gap-1">
            {option.previews.map((theme) => (
              <ThemeSample key={theme.id} theme={theme} />
            ))}
          </span>
          <span className="mt-2 flex min-w-0 items-center justify-between gap-2 text-sm">
            <span className="truncate">{option.name}</span>
            {appearance.theme === option.id && (
              <CheckIcon aria-hidden size={14} className="shrink-0 text-link" />
            )}
          </span>
          {option.id === "system" && (
            <span className="block text-xs text-muted-foreground">Follows light and dark</span>
          )}
        </button>
      ))}
    </div>
  );
}
