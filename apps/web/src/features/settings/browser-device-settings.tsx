import { desktopFolders } from "@/boot/desktop-folders.ts";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  useAlwaysShowDevices,
  useAutomaticPip,
  useRevealAgentPages,
} from "@/features/panels/index.ts";
import { useDesktopPreferences } from "./data/desktop-preferences.ts";
import { useSettingWrite } from "./data/use-settings.ts";
import { settingRow } from "./settings-index.ts";

/**
 * How this device shows browser pages, and where the desktop app's own browser saves downloads.
 * Both are kept on this device, so they sit on General rather than on a machine's Browser page,
 * where an offline machine would hide them.
 */
export function BrowserDeviceSettings() {
  const desktop = useDesktopPreferences();
  const write = useSettingWrite("Downloads folder");
  const folders = desktopFolders();
  const [always, setAlways] = useAlwaysShowDevices();
  const [automaticPip, setAutomaticPip] = useAutomaticPip();
  const [revealPages, setRevealPages] = useRevealAgentPages();
  const appFolder = desktop.value?.browserDownloads ?? null;
  return (
    <>
      <SettingSection label="Browser" card scope="device">
        <SettingRow
          id="browser.deviceToolbar"
          title="Device toolbar in new tabs"
          htmlFor="browser-device-toolbar"
          inline
        >
          <Switch id="browser-device-toolbar" checked={always} onCheckedChange={setAlways} />
        </SettingRow>
        <SettingRow
          {...settingRow("browser.pip")}
          description="While an agent browses or the page plays sound."
          htmlFor="browser-pip"
          inline
        >
          <Switch id="browser-pip" checked={automaticPip} onCheckedChange={setAutomaticPip} />
        </SettingRow>
        <SettingRow {...settingRow("browser.revealAgentPages")} htmlFor="browser-reveal" inline>
          <Switch id="browser-reveal" checked={revealPages} onCheckedChange={setRevealPages} />
        </SettingRow>
      </SettingSection>
      {desktop.available && (
        <SettingSection label="Desktop app downloads" card scope="computer">
          <SettingRow
            id="browser.appDownloads"
            title="Downloads folder"
            description={appFolder ?? "Your Downloads folder"}
          >
            <span className="flex items-center gap-2">
              {appFolder && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void write.run(() => desktop.update({ browserDownloads: null }))}
                >
                  Use default
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={!folders || !desktop.value}
                onClick={() =>
                  void folders?.choose().then((chosen) => {
                    if (chosen) void write.run(() => desktop.update({ browserDownloads: chosen }));
                  })
                }
              >
                Choose folder…
              </Button>
            </span>
          </SettingRow>
        </SettingSection>
      )}
    </>
  );
}
