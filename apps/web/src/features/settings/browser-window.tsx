import { useId, type ReactNode } from "react";
import { desktopFolders } from "@/boot/desktop-folders.ts";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  useAlwaysShowDevices,
  useAutomaticPip,
  useConnectionStatsShown,
  useExtensionsShown,
  useRevealAgentPages,
} from "@/features/panels/index.ts";
import { useDesktopPreferences } from "./data/desktop-preferences.ts";
import { useSettingWrite } from "./data/use-settings.ts";
import { settingRow, type SettingId } from "./settings-index.ts";

/**
 * Settings › Browser › In this window: how this browser or app shows a thread's pages, and where
 * the desktop app's own browser saves downloads. Kept here whatever machine Settings edits, so
 * an offline machine never hides them.
 */
export function BrowserInThisWindow() {
  const [always, setAlways] = useAlwaysShowDevices();
  const [pip, setPip] = useAutomaticPip();
  const [reveal, setReveal] = useRevealAgentPages();
  const [extensions, setExtensions] = useExtensionsShown();
  const [stats, setStats] = useConnectionStatsShown();
  return (
    <SettingSection label="In this window">
      <WindowSwitch entry="browser.deviceToolbar" checked={always} onChange={setAlways} />
      <WindowSwitch entry="browser.pip" checked={pip} onChange={setPip} />
      <WindowSwitch entry="browser.revealAgentPages" checked={reveal} onChange={setReveal} />
      <WindowSwitch
        entry="browser.extensionsButton"
        checked={extensions}
        onChange={setExtensions}
      />
      <WindowSwitch entry="browser.connectionStats" checked={stats} onChange={setStats} />
      <AppDownloadsRow />
    </SettingSection>
  );
}

function WindowSwitch(props: {
  entry: SettingId;
  checked: boolean;
  onChange(value: boolean): void;
  description?: ReactNode;
}) {
  const id = useId();
  const row = settingRow(props.entry);
  return (
    <SettingRow {...row} description={props.description ?? row.description} htmlFor={id} inline>
      <Switch id={id} checked={props.checked} onCheckedChange={props.onChange} />
    </SettingRow>
  );
}

/**
 * Where the desktop app's in-app browser saves files, on this computer. ace's Chrome keeps its
 * own folder on the machine (`browser.downloadDir`). Absent outside the desktop app.
 */
function AppDownloadsRow() {
  const desktop = useDesktopPreferences();
  const write = useSettingWrite("Downloads folder");
  const folders = desktopFolders();
  if (!desktop.available) return null;
  const folder = desktop.value?.browserDownloads ?? null;
  const row = settingRow("browser.appDownloads");
  return (
    <SettingRow
      {...row}
      description={`${folder ?? "Your Downloads folder"}. ${row.description ?? ""}`.trim()}
    >
      <span className="flex items-center gap-2">
        {folder && (
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
  );
}
