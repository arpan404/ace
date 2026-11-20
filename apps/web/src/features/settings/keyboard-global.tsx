import { useEffect, useState } from "react";
import { desktopShortcutHint } from "@/boot/desktop-settings.ts";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { useDesktopPreferences } from "./data/desktop-preferences.ts";
import { useSettingWrite } from "./data/use-settings.ts";
import { DesktopShortcut } from "./desktop-shortcut.tsx";

/**
 * What the shortcut still needs on this desktop, asked again whenever it changes. The desktop
 * registers it after saving, so the answer is read a moment later.
 */
function useShortcutHint(
  shortcut: string | null | undefined,
  which: "shortcutHint" | "talkShortcutHint" = "shortcutHint",
): string | undefined {
  const [answer, setAnswer] = useState<{ shortcut: string; hint: string | undefined }>();
  useEffect(() => {
    if (!shortcut) return;
    let current = true;
    const timer = setTimeout(() => {
      void desktopShortcutHint(globalThis, which).then((hint) => {
        if (current) setAnswer({ shortcut, hint });
      });
    }, 500);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [shortcut, which]);
  // An answer about an earlier shortcut says nothing about this one.
  return shortcut && answer?.shortcut === shortcut ? answer.hint : undefined;
}

/** Shortcuts that work while ace is in the background. Only the desktop app has them. */
export function GlobalShortcuts() {
  const { value, update } = useDesktopPreferences();
  const hint = useShortcutHint(value?.globalShortcut);
  // The desktop hands over the chord in force, its default filled in.
  const talk = value?.spadeTalkShortcut ?? null;
  const talkHint = useShortcutHint(talk, "talkShortcutHint");
  const write = useSettingWrite("Global shortcut");
  if (!value) return null;
  return (
    <SettingSection label="Global" card>
      <SettingRow id="app.globalShortcut" title="Quick-thread global shortcut" inline>
        <DesktopShortcut
          value={value.globalShortcut}
          onChange={(globalShortcut) => write.run(() => update({ globalShortcut }))}
        />
      </SettingRow>
      {hint && <p className="select-text text-sm text-muted-foreground">{hint}</p>}
      <SettingRow
        id="app.spadeTalkShortcut"
        title="Talk to Spade"
        description="Press, talk, and it sends when you stop. Press again to send at once."
        inline
      >
        <DesktopShortcut
          label="Talk to Spade shortcut"
          offLabel="Turn off the Talk to Spade shortcut"
          value={talk}
          onChange={(spadeTalkShortcut) => write.run(() => update({ spadeTalkShortcut }))}
        />
      </SettingRow>
      {talkHint && <p className="select-text text-sm text-muted-foreground">{talkHint}</p>}
    </SettingSection>
  );
}
