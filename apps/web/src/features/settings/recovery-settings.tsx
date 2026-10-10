import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useKeys } from "@/lib/keybindings.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { settingKeys, type FollowUp } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";
import { SettingSwitch } from "./setting-switch.tsx";

const followUps: { value: FollowUp; label: string }[] = [
  { value: "queue", label: "Queue" },
  { value: "steer", label: "Steer" },
];

/**
 * How threads carry on: messages sent while the agent works and work interrupted by a restart. Daemon settings, so every device follows them.
 * What happens at a usage limit lives with the accounts it concerns.
 */
export function RecoverySettings() {
  const followRow = settingRow("threads.followUpBehavior");
  const followUp = useSettingControl(settingKeys.followUp, followRow.title);
  const send = useKeys("send");
  return (
    <SettingSection label="While agents work" card scope="daemon">
      <SettingRow
        {...followRow}
        description={`Queue waits for the turn to finish; Steer adds it to the running turn. ${formatKeys(send)} does the other.`}
      >
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
        description="Work cut off by an update or reboot picks up again on its own. Off, it waits for you."
      />
    </SettingSection>
  );
}
