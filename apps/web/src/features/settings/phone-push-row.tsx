import { useConnectionState } from "@ace/client-react";
import { remotePushSwitch } from "@ace/ui-core";
import { useId } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { settingRow } from "./settings-index.ts";

/**
 * Push when the app is closed (`notifications.remotePush`): this machine sends its phones' alerts
 * through ace's push gateway (ADR 0106). Off, phones get alerts only while the app runs.
 */
export function PhonePushRow() {
  const id = useId();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const [on, setOn] = useDaemonSetting("notifications.remotePush");
  const row = settingRow("notifications.remotePush");
  return (
    <SettingRow {...row} description={remotePushSwitch.description} htmlFor={id} inline>
      <Switch
        id={id}
        checked={on === true}
        disabled={!ready || on === undefined}
        onCheckedChange={(next) =>
          void setOn(next).catch((cause: unknown) =>
            toast.error({
              title: `Couldn't save ${row.title}`,
              description: cause instanceof Error ? cause.message : undefined,
            }),
          )
        }
      />
    </SettingRow>
  );
}
