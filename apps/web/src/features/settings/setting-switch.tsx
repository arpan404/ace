import { useId, type ReactNode } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import type { SettingDef } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow, type SettingId } from "./settings-index.ts";

/** A settings row whose control is one boolean daemon setting. */
export function SettingSwitch(props: {
  setting: SettingDef<boolean>;
  /** Its entry in the settings index: the row's anchor and title. */
  entry: SettingId;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const row = settingRow(props.entry);
  const control = useSettingControl(props.setting, row.title);
  return (
    <SettingRow {...row} description={props.description} htmlFor={id} inline>
      <DaemonSlot control={control}>
        <Switch
          id={id}
          checked={control.value}
          disabled={(props.disabled ?? false) || control.offline}
          onCheckedChange={control.set}
        />
      </DaemonSlot>
    </SettingRow>
  );
}
