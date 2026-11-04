import { useConnectionState } from "@ace/client-react";
import { useId, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { DisableDevicesDialog } from "./disable-devices-dialog.tsx";
import { EmulatorWindowRow } from "./emulator-window.tsx";

/**
 * Settings › Devices: this machine's iOS Simulators and Android emulators, on or off for every
 * thread, and how Android emulators open. Turning devices off asks first, since it ends what
 * agents and live views are doing on them.
 */
export function DevicesSettings() {
  return (
    <SettingSection label="Simulators and emulators">
      <DevicesSwitchRow />
      <EmulatorWindowRow />
    </SettingSection>
  );
}

/** `devices.enabled`: on unless turned off here; it stays off across restarts. */
function DevicesSwitchRow() {
  const id = useId();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const [enabled, setEnabled] = useDaemonSetting("devices.enabled");
  const [confirming, setConfirming] = useState(false);
  const save = (next: boolean) =>
    void setEnabled(next).catch((cause: unknown) =>
      toast.error({
        title: next ? "Couldn't turn devices on" : "Couldn't turn devices off",
        description: cause instanceof Error ? cause.message : undefined,
      }),
    );
  return (
    <>
      <SettingRow
        id="devices.enabled"
        title="Use simulators and emulators"
        description="Watch and drive this machine's iOS Simulators and Android emulators from any thread, and let agents use them."
        htmlFor={id}
        inline
      >
        <Switch
          id={id}
          checked={enabled !== false}
          disabled={!ready || enabled === undefined}
          onCheckedChange={(next) => (next ? save(true) : setConfirming(true))}
        />
      </SettingRow>
      <DisableDevicesDialog
        open={confirming}
        onOpenChange={setConfirming}
        onDisable={() => save(false)}
      />
    </>
  );
}
