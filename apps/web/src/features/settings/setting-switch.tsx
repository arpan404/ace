import { useId, type ReactNode } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import type { SettingDef } from "./data/setting-keys.ts";
import { useSetting } from "./data/use-settings.ts";

/** A settings row whose control is one boolean daemon setting. */
export function SettingSwitch(props: {
  setting: SettingDef<boolean>;
  title: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const [on, set] = useSetting(props.setting);
  return (
    <SettingRow title={props.title} description={props.description} htmlFor={id}>
      <Switch
        id={id}
        checked={on}
        disabled={props.disabled ?? false}
        onCheckedChange={(checked) => void set(checked)}
      />
    </SettingRow>
  );
}
