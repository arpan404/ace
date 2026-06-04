import { memo, type CSSProperties } from "react";

import { THEME_PRESET_OPTIONS, type ThemePresetId } from "~/themePresets";
import { cn } from "~/lib/utils";

export const ThemePresetPicker = memo(function ThemePresetPicker({
  value,
  onChange,
  className,
}: {
  value: ThemePresetId;
  onChange: (preset: ThemePresetId) => void;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)} aria-label="Theme presets">
      <div className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 [@media(max-height:760px)]:sm:grid-cols-3 [@media(max-height:640px)]:sm:grid-cols-4">
        {THEME_PRESET_OPTIONS.map((option) => {
          const active = value === option.id;
          const { preview } = option;
          const isGlass = option.id === "glass";
          const panelLeft = isGlass ? preview.panelDeep : preview.panel;
          const panelRight = isGlass ? preview.panel : preview.panelDeep;
          const presetStyle = {
            ["--preset-accent" as string]: preview.accent,
          } as CSSProperties;

          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              aria-label={option.label}
              onClick={() => {
                onChange(option.id);
              }}
              className={cn(
                "group flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[calc(var(--control-radius)+2px)] border px-2 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[color:var(--preset-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                active
                  ? "border-foreground/22 bg-foreground/[0.055] text-foreground"
                  : "border-transparent bg-transparent text-muted-foreground/72 hover:border-border/40 hover:bg-foreground/[0.035] hover:text-foreground/92",
              )}
              style={presetStyle}
            >
              <span className="flex h-6 w-10 shrink-0 overflow-hidden rounded-[var(--control-radius)] border border-border/30">
                <span className="h-full flex-1" style={{ background: panelLeft }} />
                <span className="h-full flex-1" style={{ background: panelRight }} />
                <span className="h-full w-2" style={{ background: preview.accent }} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{option.label}</span>
                <span className="mt-0.5 flex items-center gap-1.5">
                  <span className="h-1.5 w-5 rounded-full" style={{ background: preview.accent }} />
                  <span
                    className="h-1.5 w-5 rounded-full"
                    style={{ background: preview.accentMuted }}
                  />
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});
