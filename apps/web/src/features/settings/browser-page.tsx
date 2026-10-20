import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { desktopFolders } from "@/boot/desktop-folders.ts";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  useAlwaysShowDevices,
  useAutomaticPip,
  useRevealAgentPages,
} from "@/features/panels/index.ts";
import { settingKeys } from "./data/setting-keys.ts";
import { useDesktopPreferences } from "./data/desktop-preferences.ts";
import { useSetting, useSettingControl, useSettingWrite } from "./data/use-settings.ts";
import { DaemonSlot, useNotConnectedNote } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";

const engines = [
  { value: "auto", label: "Desktop app, else ace's Chrome" },
  { value: "embedded", label: "Desktop app only" },
  { value: "headless", label: "ace's Chrome only" },
] as const;
const profiles = [
  { value: "persistent", label: "Keep sign-ins" },
  { value: "ephemeral", label: "Private" },
] as const;
const losses = [
  { value: "pause", label: "Pause" },
  { value: "headless", label: "Continue in ace's Chrome" },
] as const;

/** A folder path typed for a machine ace can't show a picker for (the daemon's). */
function FolderField(props: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onSave(value: string): void;
}) {
  const [draft, setDraft] = useState<string>();
  const save = () => {
    if (draft === undefined) return;
    setDraft(undefined);
    if (draft.trim() !== props.value) props.onSave(draft.trim());
  };
  return (
    <Input
      aria-label={props.label}
      value={draft ?? props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
        if (event.key === "Escape") setDraft(undefined);
      }}
      className="w-60 font-mono text-xs"
    />
  );
}

/**
 * Settings › Browser. Each part says where it applies: ace's Chrome runs in the daemon (its
 * settings live there, a remote daemon's on its own machine); the desktop app's own browser
 * keeps its downloads folder in this app; the person's Chrome decides for itself.
 */
export function BrowserSettings() {
  const navigate = useNavigate();
  const note = useNotConnectedNote();
  const [machine] = useSetting(settingKeys.hostName);
  const engine = useSettingControl(settingKeys.browserEngine, settingRow("browser.engine").title);
  const profile = useSettingControl(
    settingKeys.browserProfile,
    settingRow("browser.profile").title,
  );
  const loss = useSettingControl(settingKeys.browserLoss, settingRow("browser.loss").title);
  const downloads = useSettingControl(
    settingKeys.browserDownloads,
    settingRow("browser.downloadDir").title,
  );
  const [machineDownloads] = useSetting(settingKeys.browserDownloadDefault);
  const desktop = useDesktopPreferences();
  const write = useSettingWrite("Downloads folder");
  const folders = desktopFolders();
  const [always, setAlways] = useAlwaysShowDevices();
  const [automaticPip, setAutomaticPip] = useAutomaticPip();
  const [revealPages, setRevealPages] = useRevealAgentPages();
  const appFolder = desktop.value?.browserDownloads ?? null;
  return (
    <>
      <SettingSection
        label={machine ? `ace's Chrome · Daemon on ${machine}` : "ace's Chrome · This daemon"}
        card
        scope="daemon"
        note={note}
      >
        <SettingRow
          {...settingRow("browser.engine")}
          description="Where a thread's browser opens. ace's Chrome keeps agents working without the app."
        >
          <DaemonSlot control={engine}>
            <Select
              label="Browser engine"
              value={engine.value}
              options={engines}
              disabled={engine.offline}
              onValueChange={engine.set}
              className="w-56"
            />
          </DaemonSlot>
        </SettingRow>
        <SettingRow {...settingRow("browser.profile")}>
          <DaemonSlot control={profile}>
            <SegmentedControl
              label="New browsers"
              value={profile.value}
              options={profiles}
              onValueChange={profile.set}
            />
          </DaemonSlot>
        </SettingRow>
        <SettingRow {...settingRow("browser.loss")}>
          <DaemonSlot control={loss}>
            <SegmentedControl
              label="When the desktop app goes away"
              value={loss.value}
              options={losses}
              onValueChange={loss.set}
            />
          </DaemonSlot>
        </SettingRow>
        <SettingRow
          {...settingRow("browser.downloadDir")}
          description={
            machineDownloads
              ? "A folder on the daemon's machine. Empty uses its Downloads folder."
              : "A folder on the daemon's machine. Its Downloads folder is missing or read-only, so with none chosen, downloads stay with each thread's browser data."
          }
        >
          <DaemonSlot control={downloads}>
            <FolderField
              label="Downloads folder for ace's Chrome"
              value={downloads.value}
              placeholder={machineDownloads || "With each thread"}
              disabled={downloads.offline}
              onSave={downloads.set}
            />
          </DaemonSlot>
        </SettingRow>
      </SettingSection>
      {desktop.available && (
        <SettingSection label="This computer's ace app" card scope="computer">
          <SettingRow
            id="browser.appDownloads"
            title="Downloads folder"
            description={appFolder ?? "Your Downloads folder (default)"}
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
      <SettingSection label="Use my Chrome" card>
        <SettingRow
          id="browser.userChrome"
          title="Downloads"
          description="Your Chrome saves them where it always does."
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void navigate({ to: "/settings/computer-use" })}
          >
            Use my Chrome settings
          </Button>
        </SettingRow>
      </SettingSection>
      <SettingSection label="This device" card scope="device">
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
          description="Float the page in a small window when you leave the Browser while an agent browses or the page plays sound."
          htmlFor="browser-pip"
          inline
        >
          <Switch id="browser-pip" checked={automaticPip} onCheckedChange={setAutomaticPip} />
        </SettingRow>
        <SettingRow {...settingRow("browser.revealAgentPages")} htmlFor="browser-reveal" inline>
          <Switch id="browser-reveal" checked={revealPages} onCheckedChange={setRevealPages} />
        </SettingRow>
      </SettingSection>
    </>
  );
}
