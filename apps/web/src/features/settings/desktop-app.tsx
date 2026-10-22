import type { DesktopPreferencesPatch } from "@/boot/desktop-settings.ts";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { AppUpdateRow } from "./app-updates.tsx";
import { useDesktopPreferences } from "./data/desktop-preferences.ts";
import { DesktopShortcut } from "./desktop-shortcut.tsx";
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
export function DesktopAppPreferences() {
  const { value, update } = useDesktopPreferences();
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
      <AppUpdateRow />
    </SettingSection>
  );
}
