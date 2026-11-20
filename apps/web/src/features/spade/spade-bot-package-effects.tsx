import { decidedEachTime, effectWords, type SpadePackageEffect } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { botSecurityKey, setPackageEffect } from "./spade-security-api.ts";
import { Refusal } from "./spade-settings-rows.tsx";
import { agentsKey, type RosterBot } from "./use-spade-roster.ts";

/*
 * A packaged bot's declared effects in its Security section (ADR 0200 §3.4), as the install
 * review showed them: each a row in plain words with its reason and a switch. Turning one on is
 * the person's grant (its hosts join the allow list, its grant is made); off narrows the
 * ceiling. Only what the package declared is here, so nothing undeclared can be turned on; a
 * send, a payment or an access change still asks each time.
 */

export function ProfilePackageEffects(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const [saving, setSaving] = useState<string>();
  const [refusal, setRefusal] = useState<string>();
  const effects = bot.package?.effects ?? [];
  if (!effects.length) return null;
  const turn = async (row: SpadePackageEffect, on: boolean) => {
    setSaving(row.key);
    setRefusal(undefined);
    try {
      await setPackageEffect(client, bot.id, row.key, on);
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      // The switch is the bot's package view; what it made shows in its grants and network.
      await Promise.all([
        cache.invalidateQueries({ queryKey: agentsKey }),
        cache.invalidateQueries({ queryKey: botSecurityKey(machine, bot.id, "bot") }),
      ]);
      setSaving(undefined);
    }
  };
  return (
    <>
      {effects.map((row) => {
        const words = effectWords(row);
        return (
          <SettingRow
            key={row.key}
            title={words}
            description={`${row.why}${decidedEachTime(row) ? " You decide each time." : ""}`}
            density="compact"
            inline
          >
            <Switch
              aria-label={words}
              checked={row.on}
              disabled={saving !== undefined}
              onCheckedChange={(on) => void turn(row, on)}
            />
          </SettingRow>
        );
      })}
      {refusal && (
        <p data-setting-slot="" className="py-2 text-xs">
          <Refusal>{refusal}</Refusal>
        </p>
      )}
    </>
  );
}
