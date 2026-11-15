import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { themeIds, themes } from "@ace/themes";
import { useTheme } from "@/theme/theme-provider.tsx";
import { AppPreview } from "./app-preview.tsx";
import { PickerCard } from "./picker-card.tsx";
import { part } from "@/lib/suit-part.ts";

/**
 * Every theme as the app in miniature, in the scheme on screen now: switching Light or Dark above
 * redraws them all, so each shows exactly what choosing it gives. While a Suit is on screen it
 * leads the row as the chosen look, and choosing a theme turns the Suit off.
 */
export function ThemeChooser() {
  const { appearance, update, resolved, suit } = useTheme();
  return (
    <div
      role="radiogroup"
      {...part("list", undefined, "theme")}
      aria-label="Theme"
      onKeyDown={onRadioKeys}
      className="grid w-full grid-cols-2 gap-x-4 gap-y-5 @min-[420px]:grid-cols-3 @min-[420px]:gap-x-5"
    >
      {suit && (
        <PickerCard
          label={`Custom · ${suit.manifest.name}`}
          description={suit.manifest.description || "A Suit made for you"}
          checked
          onChoose={() => undefined}
          preview={
            <AppPreview
              look={{ suit: suit.manifest.id }}
              scheme={resolved.scheme}
              className="aspect-[16/9]"
            />
          }
        />
      )}
      {themeIds.map((id) => (
        <PickerCard
          key={id}
          label={themes[id].name}
          description={themes[id].character}
          checked={!suit && appearance.theme === id}
          onChoose={() => update({ theme: id, suit: null })}
          labelStyle={{ fontFamily: themes[id].fonts.ui }}
          preview={
            <AppPreview look={{ theme: id }} scheme={resolved.scheme} className="aspect-[16/9]" />
          }
        />
      ))}
    </div>
  );
}
