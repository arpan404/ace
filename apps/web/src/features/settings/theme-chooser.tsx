import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { themeIds, themes } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { AppPreview } from "./app-preview.tsx";
import { PickerCard } from "./picker-card.tsx";

/** Every theme as a card: the app in that theme, in the mode on screen. */
export function ThemeChooser() {
  const { appearance, update, resolved } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onRadioKeys}
      className="grid max-w-[620px] grid-cols-2 gap-2 @min-[420px]:grid-cols-3 @min-[420px]:gap-3"
    >
      {themeIds.map((id) => (
        <PickerCard
          key={id}
          label={themes[id].name}
          description={themes[id].character}
          checked={appearance.theme === id}
          onChoose={() => update({ theme: id })}
          labelStyle={{ fontFamily: themes[id].fonts.ui }}
          preview={<AppPreview theme={id} scheme={resolved.scheme} className="aspect-[16/10]" />}
        />
      ))}
    </div>
  );
}
