import { memo, type CSSProperties } from "react";

import { THEME_PRESET_OPTIONS, type ThemePresetId } from "~/themePresets";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";

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
    <div className={cn("min-w-0", className)} role="listbox" aria-label="Theme presets">
      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(8.75rem,1fr))] gap-1.5">
        {THEME_PRESET_OPTIONS.map((option) => {
          const active = value === option.id;
          const { preview } = option;
          const isGlass = option.id === "glass";
          const mockBackground = isGlass
            ? `linear-gradient(145deg, ${preview.panelDeep}, ${preview.panel})`
            : `linear-gradient(145deg, ${preview.panel}, ${preview.panelDeep})`;
          const mockLeft = isGlass ? preview.panelDeep : preview.panel;
          const mockRight = isGlass ? preview.panel : preview.panelDeep;
          const accent = preview.accent;
          const presetStyle = {
            ["--preset-accent" as string]: accent,
          } as CSSProperties;

          return (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={active}
              aria-label={option.label}
              onClick={() => {
                onChange(option.id);
              }}
              className={cn(
                "group relative flex h-[68px] w-full min-w-0 flex-col overflow-hidden rounded-[var(--control-radius)] border p-1.5 text-left outline-none transition-[border-color,box-shadow,background-color,transform] duration-150 hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-[color:var(--preset-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                !active &&
                  "border-pill-border/55 bg-background/34 hover:border-muted-foreground/35 hover:bg-foreground/[0.035]",
                active && "border-transparent",
              )}
              style={
                active
                  ? {
                      ...presetStyle,
                      borderColor: accent,
                      backgroundColor: `color-mix(in oklch, ${accent} 7%, var(--pill))`,
                      boxShadow: `0 0 0 1px color-mix(in oklch, ${accent} 38%, transparent)`,
                    }
                  : presetStyle
              }
            >
              {active ? (
                <Badge
                  variant="outline"
                  size="sm"
                  className="absolute top-1 right-1 z-10 h-4.5 rounded-[var(--control-radius)] border px-1.5 text-[9.5px] font-medium text-foreground"
                  style={{
                    borderColor: `color-mix(in oklch, ${accent} 30%, var(--border))`,
                    backgroundColor: `color-mix(in oklch, ${accent} 18%, var(--pill))`,
                  }}
                >
                  Active
                </Badge>
              ) : null}
              <div
                className={cn(
                  "flex min-h-0 shrink-0 items-center justify-between gap-1",
                  active && "pr-10",
                )}
              >
                <p className="truncate text-[11px] font-semibold leading-tight text-foreground">
                  {option.label}
                </p>
              </div>
              <div
                className="mt-1 flex min-h-0 flex-1 flex-col rounded-[calc(var(--control-radius)-1px)] border border-white/5 p-1.25"
                style={{
                  background: mockBackground,
                }}
              >
                <div className="flex min-h-0 flex-1 gap-1">
                  <div
                    className="min-w-0 flex-1 rounded-sm  ring-1 ring-white/10"
                    style={{ background: mockLeft }}
                  />
                  <div
                    className="min-w-0 flex-1 rounded-sm  ring-1 ring-white/10"
                    style={{ background: mockRight }}
                  />
                </div>
                <div className="mt-1 flex h-1.25 shrink-0 overflow-hidden rounded-full ring-1 ring-white/10">
                  <div className="h-full w-1/2" style={{ background: preview.accent }} />
                  <div className="h-full w-1/2" style={{ background: preview.accentMuted }} />
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});
