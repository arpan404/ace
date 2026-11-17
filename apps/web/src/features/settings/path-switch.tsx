import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useId } from "react";
import { Switch } from "@/components/ui/switch.tsx";
import { outsideKeys } from "@/features/connected-apps/index.ts";
import type { SettingDef } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";

/**
 * A way in's on/off; what it changes is read again: the outside addresses, or the automation
 * lists that carry webhooks' state. `blocked` keeps it from being turned on, never off.
 */
export function PathSwitch(props: {
  setting: SettingDef<boolean>;
  title: string;
  refreshes?: QueryKey;
  blocked?: boolean;
}) {
  const id = useId();
  const control = useSettingControl(props.setting, props.title);
  const queries = useQueryClient();
  return (
    <DaemonSlot control={control}>
      <Switch
        id={id}
        aria-label={props.title}
        checked={control.value}
        disabled={control.offline || (props.blocked === true && !control.value)}
        onCheckedChange={(on) => {
          control.set(on);
          void queries.invalidateQueries({ queryKey: props.refreshes ?? outsideKeys.endpoints });
        }}
      />
    </DaemonSlot>
  );
}
