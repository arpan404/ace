import { useState } from "react";
import type { DesktopPreferencesPatch } from "@/boot/desktop-settings.ts";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useDesktopPreferences } from "./data/desktop-preferences.ts";
import { useSettingWrite } from "./data/use-settings.ts";

const toggles = [
  ["openAtLogin", "Open ace at login"],
  ["background", "Keep running in background"],
  ["preventSleep", "Prevent sleep while agents work"],
  ["attention", "Bounce dock icon for attention"],
] as const;
export function DesktopAppPreferences() {
  const { value, update } = useDesktopPreferences();
  const write = useSettingWrite("App preferences");
  const [shortcut, setShortcut] = useState<string>();
  const save = (patch: DesktopPreferencesPatch) => write.run(() => update(patch));
  if (!value) return null;
  const keys = shortcut ?? value.globalShortcut ?? "";
  return (
    <SettingSection label="App" scope="computer">
      {toggles.map(([key, title]) => (
        <SettingRow key={key} title={title} htmlFor={`app-${key}`} inline>
          <Switch
            id={`app-${key}`}
            checked={value[key]}
            onCheckedChange={(on) => save({ [key]: on })}
          />
        </SettingRow>
      ))}
      <SettingRow title="Quick-thread global shortcut" htmlFor="app-shortcut">
        <form
          className="flex min-w-0 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save({ globalShortcut: keys.trim() || null });
          }}
        >
          <Input
            id="app-shortcut"
            placeholder="Off, e.g. CommandOrControl+Shift+N"
            value={keys}
            maxLength={64}
            className="min-w-0"
            onChange={(event) => setShortcut(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            disabled={keys === (value.globalShortcut ?? "")}
          >
            Save
          </Button>
        </form>
      </SettingRow>
    </SettingSection>
  );
}
