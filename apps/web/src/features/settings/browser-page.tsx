import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { useSetting, useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot, useNotConnectedNote } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";

const engines = [
  { value: "auto", label: "App, then ace's Chrome" },
  { value: "embedded", label: "Desktop app only" },
  { value: "headless", label: "ace's Chrome only" },
] as const;
const profiles = [
  { value: "persistent", label: "Keep sign-ins" },
  { value: "ephemeral", label: "Private" },
] as const;
const scopes = [
  { value: "global", label: "Global" },
  { value: "project", label: "Each project" },
  { value: "thread", label: "Each thread" },
] as const;
const losses = [
  { value: "pause", label: "Pause" },
  { value: "headless", label: "Use ace's Chrome" },
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
 * Settings › Browser, for the machine picked in Settings: ace's Chrome runs on that machine and
 * keeps its settings there; the person's Chrome decides for itself. How this device shows pages
 * and where the desktop app saves downloads live on General (`BrowserDeviceSettings`).
 */
export function BrowserSettings() {
  const navigate = useNavigate();
  const note = useNotConnectedNote();
  const engine = useSettingControl(settingKeys.browserEngine, settingRow("browser.engine").title);
  const profile = useSettingControl(
    settingKeys.browserProfile,
    settingRow("browser.profile").title,
  );
  const scope = useSettingControl(
    settingKeys.browserProfileScope,
    settingRow("browser.profileScope").title,
  );
  const loss = useSettingControl(settingKeys.browserLoss, settingRow("browser.loss").title);
  const downloads = useSettingControl(
    settingKeys.browserDownloads,
    settingRow("browser.downloadDir").title,
  );
  const [machineDownloads] = useSetting(settingKeys.browserDownloadDefault);
  return (
    <>
      <SettingSection label="ace's Chrome" card scope="daemon" note={note}>
        <SettingRow
          {...settingRow("browser.engine")}
          description="ace's Chrome keeps agents browsing without the app."
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
        <SettingRow
          {...settingRow("browser.profileScope")}
          description="A project can choose its own in Edit project."
        >
          <DaemonSlot control={scope}>
            <Select
              label="Browser profile"
              value={scope.value}
              options={scopes}
              disabled={scope.offline}
              onValueChange={scope.set}
              className="w-56"
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
              ? "Empty uses this machine's Downloads folder."
              : "No usable Downloads folder here; empty keeps them with each thread."
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
    </>
  );
}
