import { SettingRow } from "@/components/setting-row.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";
import { childLimitChoices, childLimitNote } from "@ace/ui-core";

const none = "none";

/**
 * How many delegated agents one thread runs at once on this machine. No limit by default:
 * extra agents then wait only while the machine itself is full.
 */
export function ChildLimitRow() {
  const row = settingRow("agents.maxRunningChildren");
  const limit = useSettingControl(settingKeys.maxRunningChildren, row.title);
  // A count saved elsewhere (a settings file) stays visible, so the page never lies.
  const options: SelectOption<string>[] = childLimitChoices(limit.value).map((choice) => ({
    value: choice.value === null ? none : String(choice.value),
    label: choice.label,
  }));
  return (
    <SettingRow {...row} description={childLimitNote(limit.value)}>
      <DaemonSlot control={limit}>
        <Select
          label={row.title}
          value={limit.value === null ? none : String(limit.value)}
          options={options}
          disabled={limit.offline}
          onValueChange={(next) => limit.set(next === none ? null : Number(next))}
        />
      </DaemonSlot>
    </SettingRow>
  );
}
