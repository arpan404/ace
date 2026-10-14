import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { themeIds, themes } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { PickerCard } from "./picker-card.tsx";
import { ThemeSpecimen } from "./theme-specimen.tsx";

/** Every theme as a card: a specimen of its material, light and dark side by side. */
export function ThemeChooser() {
  const { appearance, update } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onRadioKeys}
      className="grid w-full grid-cols-2 gap-4 @min-[420px]:grid-cols-3 @min-[420px]:gap-5"
    >
      {themeIds.map((id) => (
        <PickerCard
          key={id}
          label={themes[id].name}
          description={themes[id].character}
          checked={appearance.theme === id}
          onChoose={() => update({ theme: id })}
          labelStyle={{ fontFamily: themes[id].fonts.ui }}
          preview={<ThemeSpecimen id={id} />}
        />
      ))}
    </div>
  );
}
