import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { usePreferredPlace, type PanelPlace } from "@/lib/workspace/index.ts";
import { settingRow } from "./settings-index.ts";

const places: { value: PanelPlace; label: string }[] = [
  { value: "bottom", label: "Bottom panel" },
  { value: "side", label: "Side panel" },
];

/**
 * Where a thread's terminals open on this device: the bottom panel under the conversation or a
 * tab of the side panel. ⌘J and ⌃` follow it. Kept with the panels' sizes in this device's
 * layout, like them.
 */
export function TerminalSettings() {
  const [place, setPlace] = usePreferredPlace();
  return (
    <SettingSection label="Terminals" card scope="device">
      <SettingRow {...settingRow("terminals.openIn")}>
        <SegmentedControl
          label="Terminals open in"
          value={place}
          options={places}
          onValueChange={setPlace}
        />
      </SettingRow>
    </SettingSection>
  );
}
