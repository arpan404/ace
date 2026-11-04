import { EditorIcon } from "@/components/editor-icon.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Select } from "@/components/ui/select.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { useEditors } from "@/lib/editors.ts";
import { useRailMeasure } from "@/lib/rail-measure.ts";
import { usePreferredPlace, type PanelPlace } from "@/lib/workspace/index.ts";
import { DesktopAppPreferences } from "./desktop-app.tsx";
import { settingRow } from "./settings-index.ts";

const measures = [
  { value: "week", label: "Week" },
  { value: "session", label: "Session" },
] as const;

const places: { value: PanelPlace; label: string }[] = [
  { value: "bottom", label: "Bottom panel" },
  { value: "side", label: "Side panel" },
];

/**
 * What only this device keeps: the desktop app's login item and background behaviour, where
 * terminals and files open and what the rail's Usage bars show. Which computer this window
 * talks to is on Settings › Fleet; how it shows browser pages, on Settings › Browser. Agent defaults belong
 * to a machine (Settings › Agents).
 */
export function GeneralSettings() {
  return (
    <>
      <DesktopAppPreferences />
      <SettingSection label="Workspace" card scope="device">
        <TerminalPlaceRow />
        <EditorRow />
        <RailMeasureRow />
      </SettingSection>
    </>
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
    <SettingRow {...row} description={unavailable ?? row.description}>
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

/** What the rail's Usage bars show on this device: each account's week, or its session. */
function RailMeasureRow() {
  const [measure, setMeasure] = useRailMeasure();
  return (
    <SettingRow {...settingRow("usage.railMeasure")}>
      <SegmentedControl
        label="Usage bars"
        value={measure}
        options={measures}
        onValueChange={setMeasure}
      />
    </SettingRow>
  );
}
