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
      <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
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
                "group relative flex aspect-video w-full min-w-0 flex-col overflow-hidden rounded-xl border p-2 text-left outline-none transition-[border-color,box-shadow,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-[color:var(--preset-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                !active &&
                  "border-border bg-card hover:border-muted-foreground/35 hover:bg-accent/25",
                active && "border-transparent",
              )}
              style={
                active
                  ? {
                      ...presetStyle,
                      borderColor: accent,
                      backgroundColor: `color-mix(in oklch, ${accent} 8%, var(--card))`,
                      boxShadow: `0 0 0 1px color-mix(in oklch, ${accent} 40%, transparent)`,
                    }
                  : presetStyle
              }
            >
              {active ? (
                <Badge
                  variant="outline"
                  size="sm"
                  className="absolute top-1.5 right-1.5 z-10 h-5 border px-1.5 text-[10px] font-medium text-foreground"
                  style={{
                    borderColor: `color-mix(in oklch, ${accent} 30%, var(--border))`,
                    backgroundColor: `color-mix(in oklch, ${accent} 20%, var(--card))`,
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
                <p className="truncate text-[12px] font-semibold leading-tight text-foreground">
                  {option.label}
                </p>
              </div>
              <div
                className="mt-1.5 flex min-h-0 flex-1 flex-col rounded-md border border-white/5 p-1.5"
                style={{
                  background: mockBackground,
                }}
              >
                <div className="flex min-h-0 flex-1 gap-1">
                  <div
                    className="min-w-0 flex-1 rounded-sm shadow-sm ring-1 ring-white/10"
                    style={{ background: mockLeft }}
                  />
                  <div
                    className="min-w-0 flex-1 rounded-sm shadow-sm ring-1 ring-white/10"
                    style={{ background: mockRight }}
                  />
                </div>
                <div className="mt-1.5 flex h-1.5 shrink-0 overflow-hidden rounded-full ring-1 ring-white/10">
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
