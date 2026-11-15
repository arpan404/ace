import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import type { Mode } from "@/theme/appearance.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { AppPreview } from "./app-preview.tsx";
import { SuitPreview } from "./suit-preview.tsx";
import { PickerCard } from "./picker-card.tsx";
import { part } from "@/lib/suit-part.ts";

const modes: { value: Mode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * System, Light and Dark, each previewing the current theme as it will look; while a Suit is on,
 * the Suit itself in that scheme (`SuitPreview`). A Suit with one scheme shows it in all three.
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
            suit ? (
              <SuitPreview detail={suit} scheme={value === "system" ? "split" : value} />
            ) : (
              <AppPreview
                look={{ theme: resolved.theme }}
                scheme={value === "system" ? "split" : value}
                className="aspect-[16/9]"
              />
            )
          }
        />
      ))}
    </div>
  );
}
