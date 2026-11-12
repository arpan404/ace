import { useConnectionState } from "@ace/client-react";
import { devicesSwitch, simulatorToolIds } from "@ace/ui-core";
import { useId, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import {
  clearDeviceUses,
  DownloadDeviceTools,
  setScreenOnly,
  setStreamStatsShown,
  useRecentUses,
  useScreenOnly,
  useStreamStatsShown,
} from "@/features/devices/index.ts";
import { useToolchains } from "@/features/diagnostics/index.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { DisableDevicesDialog } from "./disable-devices-dialog.tsx";
import { EmulatorWindowRow } from "./emulator-window.tsx";
import { useSettingsMachine } from "./machine-scope.tsx";
import { settingRow } from "./settings-index.ts";
import { ToolchainSection } from "./toolchain-section.tsx";

/**
 * Settings › Simulators: this machine's iOS Simulators and Android emulators on or off for every
 * thread, how Android emulators open, the tools they need with how to get the missing ones, and
 * how this window shows them.
 */
export function SimulatorsSettings() {
  const { machine } = useSettingsMachine();
  const tools = useToolchains();
  // ace downloads its own streaming tools, through the window's own machine's devices channel.
  const own = !machine || machine.primary;
  return (
    <>
      <SettingSection label="Simulators and emulators">
        <SimulatorsSwitchRow />
        <EmulatorWindowRow />
      </SettingSection>
      <ToolchainSection
        label="Tools"
        anchor="tools"
        ids={simulatorToolIds}
        fixes={
          own ? { "serve-sim": <DownloadDeviceTools done={() => void tools.refetch()} /> } : {}
        }
      />
      <InThisWindow />
    </>
  );
}

/** `devices.enabled`: on unless turned off here; it stays off across restarts. */
function SimulatorsSwitchRow() {
  const id = useId();
  const toast = useToast();
  const ready = useConnectionState() === "ready";
  const [enabled, setEnabled] = useDaemonSetting("devices.enabled");
  const [confirming, setConfirming] = useState(false);
  const save = (next: boolean) =>
    void setEnabled(next).catch((cause: unknown) =>
      toast.error({
        title: next ? "Couldn't turn simulators on" : "Couldn't turn simulators off",
        description: cause instanceof Error ? cause.message : undefined,
      }),
    );
  return (
    <>
      <SettingRow
        id="devices.enabled"
        title={devicesSwitch.title}
        description={devicesSwitch.description}
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

/** How this window shows simulators: kept in this browser or app, whatever machine is picked. */
function InThisWindow() {
  const frameId = useId();
  const statsId = useId();
  const screenOnly = useScreenOnly();
  const stats = useStreamStatsShown();
  const recent = useRecentUses();
  return (
    <SettingSection label="In this window">
      <SettingRow
        {...settingRow("devices.frame")}
        description="Draws the phone or tablet around its screen. Off shows the screen alone."
        htmlFor={frameId}
        inline
      >
        <Switch
          id={frameId}
          checked={!screenOnly}
          onCheckedChange={(next) => setScreenOnly(!next)}
        />
      </SettingRow>
      <SettingRow
        {...settingRow("devices.streamStats")}
        description="Frames received and drawn, over a live screen."
        htmlFor={statsId}
        inline
      >
        <Switch id={statsId} checked={stats} onCheckedChange={setStreamStatsShown} />
      </SettingRow>
      <SettingRow
        {...settingRow("devices.recent")}
        description={
          recent.length
            ? "Clears the list under Recent in a thread's Devices tab."
            : "Nothing under Recent yet. Devices you open are listed there."
        }
        inline
      >
        <Button variant="secondary" size="sm" disabled={!recent.length} onClick={clearDeviceUses}>
          Clear
        </Button>
      </SettingRow>
    </SettingSection>
  );
}
