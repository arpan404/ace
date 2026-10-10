import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Select } from "@/components/ui/select.tsx";
import { settingKeys, type FollowUp, type UnresponsiveAfter } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";
import { SettingSwitch } from "./setting-switch.tsx";

const followUps: { value: FollowUp; label: string }[] = [
  { value: "queue", label: "Queue" },
  { value: "steer", label: "Steer" },
];

const unresponsiveOptions: { value: UnresponsiveAfter; label: string }[] = [
  { value: "2m", label: "2 minutes" },
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
];

/**
 * How threads carry on: a message sent while the agent works, work cut off by a restart, and
 * when a silent agent counts as unresponsive. Daemon settings, so every device follows them.
 * What happens at a usage limit lives with the accounts it concerns.
 */
export function RecoverySettings() {
  const followRow = settingRow("threads.followUpBehavior");
  const unresponsiveRow = settingRow("threads.unresponsiveAfter");
  const followUp = useSettingControl(settingKeys.followUp, followRow.title);
  const unresponsive = useSettingControl(settingKeys.unresponsiveAfter, unresponsiveRow.title);
  return (
    <SettingSection label="While agents work" card scope="daemon">
      <SettingRow {...followRow} description="Queue for later or steer now.">
        <DaemonSlot control={followUp}>
          <Select
            label={followRow.title}
            value={followUp.value}
            options={followUps}
            disabled={followUp.offline}
            onValueChange={followUp.set}
          />
        </DaemonSlot>
      </SettingRow>
      <SettingSwitch
        setting={settingKeys.continueAfterRestart}
        entry="threads.continueAfterRestart"
        description="Resume work after an update or reboot."
      />
      <SettingRow {...unresponsiveRow} description="Warn when an agent goes quiet.">
        <DaemonSlot control={unresponsive}>
          <Select
            label={unresponsiveRow.title}
            value={unresponsive.value}
            options={unresponsiveOptions}
            disabled={unresponsive.offline}
            onValueChange={unresponsive.set}
          />
        </DaemonSlot>
      </SettingRow>
    </SettingSection>
  );
}
