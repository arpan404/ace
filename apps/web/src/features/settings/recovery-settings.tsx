import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Select } from "@/components/ui/select.tsx";
import { formatKeys } from "@/lib/keymap.ts";
import { settingKeys, type FollowUp } from "./data/setting-keys.ts";
import { useSetting } from "./data/use-settings.ts";
import { SettingSwitch } from "./setting-switch.tsx";

const followUps: { value: FollowUp; label: string }[] = [
  { value: "queue", label: "Queue" },
  { value: "steer", label: "Steer" },
];

/**
 * How threads carry on: a message sent while the agent works and work cut off by a restart. Both
 * are daemon settings, so every device follows them. What happens at a usage limit lives with the
 * accounts it concerns (Accounts › When an account runs out).
 */
export function RecoverySettings() {
  const [followUp, setFollowUp] = useSetting(settingKeys.followUp);
  return (
    <SettingSection label="While agents work">
      <SettingRow
        title="Messages sent while the agent works"
        description={`Queue waits for the turn to finish; Steer adds it to the running turn. ${formatKeys("mod+enter")} does the other.`}
      >
        <Select
          label="Messages sent while the agent works"
          value={followUp}
          options={followUps}
          onValueChange={(value) => void setFollowUp(value)}
        />
      </SettingRow>
      <SettingSwitch
        setting={settingKeys.continueAfterRestart}
        title="Continue threads after a restart"
        description="Work cut off by an update or reboot picks up again on its own. Off, it waits for you."
      />
    </SettingSection>
  );
}
