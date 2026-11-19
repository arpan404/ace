import { atLimitLine, followUpChoices, limitPolicyChoices } from "@ace/ui-core";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useKeys } from "@/lib/keybindings.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { settingKeys, type FollowUp, type LimitPolicy } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";
import { ChildLimitRow } from "./child-limit.tsx";

const followUps: readonly { value: FollowUp; label: string }[] = followUpChoices;
const limitPolicies: readonly { value: LimitPolicy; label: string }[] = limitPolicyChoices;

/**
 * How threads carry on: messages sent while the agent works, how many delegated agents run at
 * once, and what a thread does when its account runs out. Daemon settings, so every device follows them. Work a restart interrupts
 * never continues by itself, so it has no setting.
 */
export function RecoverySettings() {
  const followRow = settingRow("threads.followUpBehavior");
  const followUp = useSettingControl(settingKeys.followUp, followRow.title);
  const limitRow = settingRow("threads.limitPolicy");
  const limit = useSettingControl(settingKeys.limitPolicy, limitRow.title);
  const send = useKeys("followUpOther");
  return (
    <SettingSection label="While agents work" card scope="daemon">
      <SettingRow
        {...followRow}
        description={
          followUp.value === "queue"
            ? `Waits for the turn to finish. ${formatKeys(send)} steers instead.`
            : `Joins the running turn. ${formatKeys(send)} queues instead.`
        }
      >
        <DaemonSlot control={followUp}>
          <SegmentedControl
            label={followRow.title}
            value={followUp.value}
            options={followUps}
            disabled={followUp.offline}
            onValueChange={followUp.set}
          />
        </DaemonSlot>
      </SettingRow>
      <SettingRow {...limitRow} description={atLimitLine(limit.value, undefined)}>
        <DaemonSlot control={limit}>
          <Select
            label={limitRow.title}
            value={limit.value}
            options={limitPolicies}
            disabled={limit.offline}
            onValueChange={limit.set}
          />
        </DaemonSlot>
      </SettingRow>
      <ChildLimitRow />
    </SettingSection>
  );
}
