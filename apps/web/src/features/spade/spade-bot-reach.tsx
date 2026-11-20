import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { ProfileSection } from "./spade-profile-parts.tsx";
import {
  readAgentReach,
  reachKey,
  setAgentReach,
  type SpadeAgentReach,
} from "./spade-reach-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault, Refusal } from "./spade-settings-rows.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

const approvalChoices: SelectOption<string>[] = [
  { value: "inherit", label: "As in Settings" },
  { value: "notify", label: "Notify me" },
  { value: "wait", label: "Wait for the morning brief" },
];

/**
 * Notifications, a section of Details (ADR 0195): whether this bot reaches the person outside
 * Spade's page, and whether its approvals and questions wait through quiet hours. On unless
 * turned off here; Spade's own settings still apply.
 */
export function ProfileReach(props: { bot: RosterBot }) {
  const id = useId();
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const key = [...reachKey, machine, "agent", props.bot.id];
  const own = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readAgentReach(client, props.bot.id, signal),
  });
  const [refusal, setRefusal] = useState<string>();
  if (own.isPending || own.isError) return null;
  const save = (change: Partial<SpadeAgentReach>) => {
    setRefusal(undefined);
    void setAgentReach(client, props.bot.id, change)
      .then(() => cache.setQueryData(key, { ...own.data, ...change }))
      .catch((error: unknown) => setRefusal(fault(error)));
  };
  return (
    <ProfileSection label="Notifications">
      <SettingRow
        inline
        title="Notify me"
        description={refusal && <Refusal>{refusal}</Refusal>}
        htmlFor={id}
      >
        <Switch
          id={id}
          checked={own.data.notify !== false}
          // On is following Spade's settings; off is this bot's own.
          onCheckedChange={(on) => save({ notify: on ? null : false })}
        />
      </SettingRow>
      {own.data.notify !== false && (
        <SettingRow inline title="During quiet hours, approvals and questions">
          <Select
            label="During quiet hours, approvals and questions"
            value={own.data.approvals ?? "inherit"}
            options={approvalChoices}
            onValueChange={(next) =>
              save({ approvals: next === "inherit" ? null : (next as "notify" | "wait") })
            }
          />
        </SettingRow>
      )}
    </ProfileSection>
  );
}
