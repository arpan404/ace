import { atLimitLine } from "@ace/ui-core";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useKeys } from "@/lib/keybindings.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { settingKeys, type FollowUp, type LimitPolicy } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";

const followUps: { value: FollowUp; label: string }[] = [
  { value: "queue", label: "Queue" },
  { value: "steer", label: "Steer" },
];

const limitPolicies: { value: LimitPolicy; label: string }[] = [
  { value: "manual", label: "Stop and ask me" },
  { value: "resume_at_reset", label: "Resume when it resets" },
  { value: "snooze_until_reset", label: "Snooze until it resets" },
  { value: "migrate_now", label: "Move to another account" },
];

/**
 * How threads carry on: messages sent while the agent works, and what a thread does when its
 * account runs out. Daemon settings, so every device follows them. Work a restart interrupts
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
    </SettingSection>
  );
}
