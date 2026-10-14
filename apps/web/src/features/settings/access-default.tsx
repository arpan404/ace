import { useConnectionState } from "@ace/client-react";
import type { AccessMode } from "@ace/protocol";
import { accessLabel, accessModes } from "@ace/ui-core";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";

const options = accessModes.map((mode) => ({ value: mode, label: accessLabel(mode) }));

/**
 * This daemon's access for new threads. A pick in any thread's access chip updates it too, so
 * it is always the person's last choice; a project's own default comes first.
 */
export function AccessDefaultRow() {
  const [value, set] = useDaemonSetting("access.defaultMode");
  const offline = useConnectionState() !== "ready";
  const [pending, setPending] = useState(false);
  const toast = useToast();
  return (
    <SettingRow {...settingRow("access.defaultMode")} description="Follows your last choice.">
      <DaemonSlot control={{ loaded: value !== undefined, offline, pending }}>
        <SegmentedControl<AccessMode>
          label="Access for new threads"
          size="sm"
          value={value ?? "auto-review"}
          options={options}
          onValueChange={(mode) => {
            setPending(true);
            void set(mode)
              .catch(() =>
                toast.error({
                  title: "Couldn't save access",
                  description: "Reconnect and try again.",
                }),
              )
              .finally(() => setPending(false));
          }}
        />
      </DaemonSlot>
    </SettingRow>
  );
}
