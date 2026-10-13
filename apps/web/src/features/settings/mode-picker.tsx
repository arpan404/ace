import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import type { Mode } from "@/theme/appearance.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { AppPreview } from "./app-preview.tsx";
import { PickerCard } from "./picker-card.tsx";

const modes: { value: Mode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

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
      {modes.map(({ value, label }) => (
        <PickerCard
          key={value}
          label={label}
          checked={appearance.mode === value}
          onChoose={() => update({ mode: value })}
          preview={
            <AppPreview
              theme={resolved.theme}
              scheme={value === "system" ? "split" : value}
              className="aspect-[4/3] @min-[420px]:aspect-[2/1]"
            />
          }
        />
      ))}
    </div>
  );
}
