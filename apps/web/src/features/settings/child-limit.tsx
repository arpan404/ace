import { SettingRow } from "@/components/setting-row.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";

const presets = [1, 2, 4, 8, 16, 32];
const none = "none";

/**
 * How many delegated agents one thread runs at once on this machine. No limit by default:
 * extra agents then wait only while the machine itself is full.
 */
export function ChildLimitRow() {
  const row = settingRow("agents.maxRunningChildren");
  const limit = useSettingControl(settingKeys.maxRunningChildren, row.title);
  // A count saved elsewhere (a settings file) stays visible, so the page never lies.
  const counts = new Set(limit.value === null ? presets : [...presets, limit.value]);
  const options: SelectOption<string>[] = [
    { value: none, label: "No limit" },
    ...[...counts]
      .toSorted((a, b) => a - b)
      .map((count) => ({ value: String(count), label: String(count) })),
  ];
  return (
    <SettingRow
      {...row}
      description={
        limit.value === null
          ? "Agents a thread hands work to all start at once."
          : "More agents a thread hands work to wait and start as these finish."
      }
    >
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
