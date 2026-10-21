import { useConnectionState } from "@ace/client-react";
import { useId } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";

/**
 * Show emulator window (`devices.emulatorWindow`): Android emulators ace boots open their own
 * window too. The daemon reads it at each boot.
 */
export function EmulatorWindowRow() {
  const id = useId();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const [shown, setShown] = useDaemonSetting("devices.emulatorWindow");
  return (
    <SettingRow
      id="devices.emulatorWindow"
      title="Show emulator window"
      description="Shows its sensor and camera controls. Applies from the next boot."
      htmlFor={id}
      inline
    >
      <Switch
        id={id}
        checked={shown === true}
        disabled={!ready || shown === undefined}
        onCheckedChange={(next) =>
          void setShown(next).catch((cause: unknown) =>
            toast.error({
              title: "Couldn't save Show emulator window",
              description: cause instanceof Error ? cause.message : undefined,
            }),
          )
        }
      />
    </SettingRow>
  );
}
