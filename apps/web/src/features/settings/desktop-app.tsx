import { useEffect, useState } from "react";
import { desktopShortcutHint, type DesktopPreferencesPatch } from "@/boot/desktop-settings.ts";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { AppUpdateRow } from "./app-updates.tsx";
import { useDesktopPreferences } from "./data/desktop-preferences.ts";
import { DesktopShortcut } from "./desktop-shortcut.tsx";
import { TerminalCommandRow } from "./terminal-command.tsx";
import { useSettingWrite } from "./data/use-settings.ts";

/** The desktop bridge's platform, set on the root element before the app loads. */
function attentionTitle(): string {
  return document.documentElement.dataset.platform === "darwin"
    ? "Bounce dock icon for attention"
    : "Flash window for attention";
}
const toggles = [
  ["openAtLogin", () => "Open ace at login"],
  ["background", () => "Keep running in background"],
  ["preventSleep", () => "Prevent sleep while agents work"],
  ["attention", attentionTitle],
] as const;
/**
 * What the shortcut still needs on this desktop, asked again whenever it changes. The desktop
 * registers it after saving, so the answer is read a moment later.
 */
function useShortcutHint(shortcut: string | null | undefined): string | undefined {
  const [answer, setAnswer] = useState<{ shortcut: string; hint: string | undefined }>();
  useEffect(() => {
    if (!shortcut) return;
    let current = true;
    const timer = setTimeout(() => {
      void desktopShortcutHint().then((hint) => {
        if (current) setAnswer({ shortcut, hint });
      });
    }, 500);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [shortcut]);
  // An answer about an earlier shortcut says nothing about this one.
  return shortcut && answer?.shortcut === shortcut ? answer.hint : undefined;
}

export function DesktopAppPreferences() {
  const { value, update } = useDesktopPreferences();
  const shortcutHint = useShortcutHint(value?.globalShortcut);
  const write = useSettingWrite("App preferences");
  const save = (patch: DesktopPreferencesPatch) => write.run(() => update(patch));
  if (!value) return null;
  return (
    <SettingSection label="App" scope="computer">
      {toggles.map(([key, title]) => (
        <SettingRow key={key} id={`app.${key}`} title={title()} htmlFor={`app-${key}`} inline>
          <Switch
            id={`app-${key}`}
            checked={value[key]}
            onCheckedChange={(on) => save({ [key]: on })}
          />
        </SettingRow>
      ))}
      <SettingRow id="app.globalShortcut" title="Quick-thread global shortcut" inline>
        <DesktopShortcut
          value={value.globalShortcut}
          onChange={(globalShortcut) => save({ globalShortcut })}
        />
      </SettingRow>
      {shortcutHint && <p className="select-text text-sm text-muted-foreground">{shortcutHint}</p>}
      <TerminalCommandRow />
      <AppUpdateRow />
    </SettingSection>
  );
}
