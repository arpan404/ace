import { parseSpadeIncoming, spadeContractEffects } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { ProfileSection } from "./spade-profile-parts.tsx";
import { segment, spadeHttp } from "./spade-requests.ts";
import { Refusal } from "./spade-settings-rows.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/*
 * A packaged bot's contracts in its profile (ADR 0200 §7): what the person's other bots may ask
 * it, each in its own words, and the person's switch for those calls. Nothing here is a bot's:
 * only the person opens a bot to calls or closes it.
 */

const path = (bot: string) => `/v1/agents/${segment(bot)}/contracts`;

export function ProfileContracts(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const key = ["spade", "contracts", machine, bot.id];
  const contracts = bot.package?.contracts ?? [];
  const incoming = useQuery({
    queryKey: key,
    enabled: contracts.length > 0,
    queryFn: async ({ signal }) => {
      const read = parseSpadeIncoming(await spadeHttp(client, "GET", path(bot.id), { signal }));
      if (read === undefined) throw new Error("Spade's answer about calls didn't make sense.");
      return read;
    },
  });
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  if (!contracts.length) return null;
  const turn = async (on: boolean) => {
    setSaving(true);
    setRefusal(undefined);
    try {
      await spadeHttp(client, "PUT", path(bot.id), { body: { incoming: on } });
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      await cache.invalidateQueries({ queryKey: key });
      setSaving(false);
    }
  };
  return (
    <ProfileSection label="Contracts">
      {contracts.map((contract) => (
        <SettingRow
          key={contract.name}
          title={contract.name}
          description={`${contract.summary} ${spadeContractEffects(contract.effects)}`}
          density="compact"
        />
      ))}
      <SettingRow
        title="Your other bots can call it"
        description="On this machine and your other machines. Other people's bots never can."
        density="compact"
        inline
      >
        <Switch
          aria-label="Your other bots can call it"
          checked={incoming.data ?? true}
          disabled={saving || incoming.data === undefined}
          onCheckedChange={(on) => void turn(on)}
        />
      </SettingRow>
      {refusal && (
        <p data-setting-slot="" className="py-2 text-xs">
          <Refusal>{refusal}</Refusal>
        </p>
      )}
    </ProfileSection>
  );
}
