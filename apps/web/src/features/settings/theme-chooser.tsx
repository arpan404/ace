import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { themeIds, themes } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { AppPreview } from "./app-preview.tsx";
import { PickerCard } from "./picker-card.tsx";

/**
 * Every theme as the app in miniature, in the scheme on screen now: switching Light or Dark above
 * redraws them all, so each shows exactly what choosing it gives.
 */
export function ThemeChooser() {
  const { appearance, update, resolved } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onRadioKeys}
      className="grid w-full grid-cols-2 gap-x-4 gap-y-5 @min-[420px]:grid-cols-3 @min-[420px]:gap-x-5"
    >
      {themeIds.map((id) => (
        <PickerCard
          key={id}
          label={themes[id].name}
          description={themes[id].character}
          checked={appearance.theme === id}
          onChoose={() => update({ theme: id })}
          labelStyle={{ fontFamily: themes[id].fonts.ui }}
          preview={<AppPreview theme={id} scheme={resolved.scheme} className="aspect-[16/9]" />}
        />
      ))}
    </div>
  );
}
