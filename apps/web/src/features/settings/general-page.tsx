import { EditorIcon } from "@/components/editor-icon.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { useEditors } from "@/lib/editors.ts";
import { useProfileName } from "@/lib/profile.ts";
import { usePreferredPlace, type PanelPlace } from "@/lib/workspace/index.ts";
import { BrowserDeviceSettings } from "./browser-device-settings.tsx";
import { DaemonSettings } from "./daemon-settings.tsx";
import { DesktopAppPreferences } from "./desktop-app.tsx";
import { settingRow } from "./settings-index.ts";

const places: { value: PanelPlace; label: string }[] = [
  { value: "bottom", label: "Bottom panel" },
  { value: "side", label: "Side panel" },
];

/**
 * What only this device keeps: the desktop app's login item and background behaviour, your
 * name, where terminals and files open, how browser pages show, and which computer this window
 * talks to. Agent
 * defaults belong to a machine (Settings › Agents).
 */
export function GeneralSettings() {
  return (
    <>
      <DesktopAppPreferences />
      <SettingSection label="You" card scope="device">
        <ProfileNameRow />
      </SettingSection>
      <SettingSection label="Workspace" card scope="device">
        <TerminalPlaceRow />
        <EditorRow />
      </SettingSection>
      <BrowserDeviceSettings />
      <DaemonSettings />
    </>
  );
}

function ProfileNameRow() {
  const [name, setName] = useProfileName();
  return (
    <SettingRow {...settingRow("profile.name")} description={undefined} htmlFor="profile-name">
      <Input
        id="profile-name"
        className="@[30rem]:w-52"
        defaultValue={name}
        placeholder="Name"
        autoComplete="name"
        maxLength={80}
        onBlur={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") setName(event.currentTarget.value);
        }}
      />
    </SettingRow>
  );
}

/**
 * Where a thread's terminals open on this device: the bottom panel under the conversation or a
 * tab of the side panel. ⌘J and ⌃` follow it.
 */
function TerminalPlaceRow() {
  const [place, setPlace] = usePreferredPlace();
  return (
    <SettingRow {...settingRow("terminals.openIn")}>
      <SegmentedControl
        label="Terminals open in"
        value={place}
        options={places}
        onValueChange={setPlace}
      />
    </SettingRow>
  );
}

/** The editor "Open in" uses first on this device, from the editors the machine has. */
function EditorRow() {
  const { editors, current, choose, unavailable } = useEditors();
  const row = settingRow("editor.default");
  return (
    <SettingRow {...row} description={unavailable}>
      {editors?.length && current ? (
        <Select
          label={row.title}
          value={current.id}
          options={editors.map((editor) => ({
            value: editor.id,
            label: editor.name,
            icon: <EditorIcon id={editor.id} />,
          }))}
          onValueChange={choose}
        />
      ) : null}
    </SettingRow>
  );
}
