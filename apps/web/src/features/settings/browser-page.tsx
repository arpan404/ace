import {
  browserDownloadsNote,
  browserEngineChoices,
  browserLossChoices,
  browserProfileChoices,
  browserProfileScopeChoices,
} from "@ace/ui-core";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { useSetting, useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot, useNotConnectedNote } from "./setting-control.tsx";
import { BrowserInThisWindow } from "./browser-window.tsx";
import { settingRow } from "./settings-index.ts";
import { UseMyChromeSettings } from "./use-my-chrome.tsx";

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
 * keeps its settings there; Use my Chrome connects the person's own Chrome on it. In this window
 * holds how this browser or app shows pages, whatever machine is picked.
 */
export function BrowserSettings() {
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
              options={browserEngineChoices}
              disabled={engine.offline}
              onValueChange={engine.set}
            />
          </DaemonSlot>
        </SettingRow>
        <SettingRow {...settingRow("browser.profile")}>
          <DaemonSlot control={profile}>
            <SegmentedControl
              label="New browsers"
              value={profile.value}
              options={browserProfileChoices}
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
              options={browserProfileScopeChoices}
              disabled={scope.offline}
              onValueChange={scope.set}
            />
          </DaemonSlot>
        </SettingRow>
        <SettingRow {...settingRow("browser.loss")}>
          <DaemonSlot control={loss}>
            <SegmentedControl
              label="When the desktop app goes away"
              value={loss.value}
              options={browserLossChoices}
              onValueChange={loss.set}
            />
          </DaemonSlot>
        </SettingRow>
        <SettingRow
          {...settingRow("browser.downloadDir")}
          description={browserDownloadsNote(machineDownloads)}
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
      <UseMyChromeSettings />
      <BrowserInThisWindow />
    </>
  );
}
