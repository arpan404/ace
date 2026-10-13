import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useKeys } from "@/lib/keybindings.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { settingKeys, type FollowUp } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";

const followUps: { value: FollowUp; label: string }[] = [
  { value: "queue", label: "Queue" },
  { value: "steer", label: "Steer" },
];

/**
 * How threads carry on: messages sent while the agent works. A daemon setting, so every device
 * follows it. Work a restart interrupts never continues by itself, so it has no setting.
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
    </SettingSection>
  );
}
