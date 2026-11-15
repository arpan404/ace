import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import type { Mode } from "@/theme/appearance.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { AppPreview } from "./app-preview.tsx";
import { PickerCard } from "./picker-card.tsx";
import { part } from "@/lib/suit-part.ts";

const modes: { value: Mode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * System, Light and Dark, each previewing the current look (the theme, or the Suit on screen) as
 * it will look in that scheme. A Suit with one scheme shows it in all three.
 */
export function ModePicker() {
  const { appearance, update, resolved, suit } = useTheme();
  return (
    <div
      role="radiogroup"
      {...part("list", undefined, "mode")}
      aria-label="Mode"
      onKeyDown={onRadioKeys}
      className="grid w-full grid-cols-3 gap-4 @min-[420px]:gap-5"
    >
      {modes.map(({ value, label }) => (
        <PickerCard
          key={value}
          label={label}
          checked={appearance.mode === value}
          onChoose={() => update({ mode: value })}
          preview={
            <AppPreview
              look={suit ? { suit } : { theme: resolved.theme }}
              scheme={value === "system" ? "split" : value}
              className="aspect-[16/9]"
            />
          }
        />
      ))}
    </div>
  );
}
