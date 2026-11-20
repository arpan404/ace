import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { ProfileSection } from "./spade-profile-parts.tsx";
import { readAgentReach, reachKey, setAgentReach } from "./spade-reach-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault, Refusal } from "./spade-settings-rows.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/**
 * Notifications, a section of Details (ADR 0194): whether this bot reaches the person outside
 * Spade's page. On unless turned off here; Spade's own settings still apply.
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
          checked={own.data !== false}
          onCheckedChange={(on) => {
            setRefusal(undefined);
            // On is following Spade's settings; off is this bot's own.
            const next = on ? null : false;
            void setAgentReach(client, props.bot.id, next)
              .then(() => cache.setQueryData(key, next))
              .catch((error: unknown) => setRefusal(fault(error)));
          }}
        />
      </SettingRow>
    </ProfileSection>
  );
}
