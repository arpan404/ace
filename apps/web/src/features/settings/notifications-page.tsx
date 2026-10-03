import { useId } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { QuietHours, settingKeys } from "./data/setting-keys.ts";
import { useSetting } from "./data/use-settings.ts";
import { SettingSwitch } from "./setting-switch.tsx";

const defaultQuietHours: QuietHours = { start: "22:00", end: "08:00" };
const soundOptions = [
  { value: "subtle", label: "Subtle" },
  { value: "none", label: "None" },
] as const;

/** What reaches this machine and paired phones. Stored in the daemon, so every client agrees. */
export function NotificationSettings() {
  const [sound, setSound] = useSetting(settingKeys.sound);
  return (
    <section className="mt-7" aria-label="Notifications">
      <SettingSwitch
        setting={settingKeys.notifyNeedsYou}
        title="Needs you"
        description="Approvals, questions and escalations. Always delivered to this machine and paired phones."
      />
      <SettingSwitch
        setting={settingKeys.notifyDone}
        title="Thread done"
        description="When a thread settles with no open items."
      />
      <SettingSwitch
        setting={settingKeys.notifyFailures}
        title="Failures and unresponsive agents"
      />
      <SettingSwitch
        setting={settingKeys.notifyMentions}
        title="Mentions"
        description="When an agent or teammate @mentions you."
      />
      <QuietHoursRow />
      <SettingRow title="Sound">
        <Select
          label="Sound"
          value={sound ? "subtle" : "none"}
          options={soundOptions}
          onValueChange={(value) => void setSound(value === "subtle")}
        />
      </SettingRow>
    </section>
  );
}

function QuietHoursRow() {
  const id = useId();
  const [quiet, setQuiet] = useSetting(settingKeys.quietHours);
  const change = (edge: "start" | "end", value: string) => {
    if (!quiet) return;
    const next = QuietHours.safeParse({ ...quiet, [edge]: value });
    if (next.success) void setQuiet(next.data);
  };
  return (
    <SettingRow
      title="Quiet hours"
      htmlFor={id}
      description={
        quiet
          ? `${quiet.start} to ${quiet.end}. Needs-you items still reach your phone.`
          : "Hold everything except needs-you items overnight."
      }
    >
      {quiet && (
        <>
          <Input
            type="time"
            aria-label="Quiet hours start"
            value={quiet.start}
            onChange={(event) => change("start", event.target.value)}
            className="h-7 w-[92px] font-mono text-[12px]"
          />
          <span className="text-sm text-subtle-foreground">to</span>
          <Input
            type="time"
            aria-label="Quiet hours end"
            value={quiet.end}
            onChange={(event) => change("end", event.target.value)}
            className="h-7 w-[92px] font-mono text-[12px]"
          />
        </>
      )}
      <Switch
        id={id}
        checked={quiet !== null}
        onCheckedChange={(on) => void setQuiet(on ? defaultQuietHours : null)}
      />
    </SettingRow>
  );
}
