import { spadeMoney, spadeRoleNames, type SpadeBotRoles } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingDisclosure, SettingRow } from "@/components/setting-row.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { ProfileProblem } from "./spade-profile-parts.tsx";
import { readBotRoles, rolesKey, setBotRoles, type SpadeRolesChange } from "./spade-roles-api.ts";
import { EffortSelect, effortFollows } from "./spade-settings-effort.tsx";
import { ModelSettingRow } from "./spade-settings-rows.tsx";
import { RetrySwitchRow } from "./spade-settings-roles.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/**
 * Details › Runs with › Models for other work (ADR 0162): a fold under the bot's model that
 * opens to its five roles. Each says what it spent this month and, when nothing is set on this
 * bot, that it follows Settings; its picker shows the model it runs on either way, with Follow
 * Settings at the top, and beside it how hard that model thinks (ADR 0213); first, how hard the
 * bot's own turns think. Then whether a failed helper runs again on the bot's own model.
 */
export function BotRoles(props: { bot: RosterBot }) {
  const [open, setOpen] = useState(false);
  return (
    <SettingDisclosure title="Models for other work" open={open} onToggle={setOpen}>
      {open && <RoleRows bot={props.bot} />}
    </SettingDisclosure>
  );
}

function RoleRows(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const key = [...rolesKey, machine, bot.id];
  const roles = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readBotRoles(client, bot.id, signal),
  });
  const change = async (next: SpadeRolesChange) => {
    cache.setQueryData<SpadeBotRoles>(key, await setBotRoles(client, bot.id, next));
  };
  if (roles.isPending) return <ListSkeleton label="models for other work" shape="row" rows={3} />;
  if (!roles.data)
    return (
      <ProfileProblem
        text="Couldn't read the models for other work."
        onRetry={() => void roles.refetch()}
      />
    );
  const { data } = roles;
  const ownTurns = data.ownEfforts.main;
  return (
    <>
      <SettingRow title="Its own turns" density="compact" inline>
        <EffortSelect
          title="Its own turns"
          value={ownTurns}
          none={effortFollows(ownTurns ? undefined : data.mainEffort)}
          save={(effort) => change({ efforts: { main: effort } })}
        />
      </SettingRow>
      {data.roles.map((row) => {
        const own = data.own[row.role];
        const spent = `${spadeMoney(row.monthMicros)} this month`;
        return (
          <ModelSettingRow
            key={row.role}
            title={spadeRoleNames[row.role]}
            description={
              <>
                <span className="block tabular-nums">{spent}</span>
                {!own && <span className="block">Follows Settings</span>}
              </>
            }
            value={own}
            none="Follow Settings"
            follows={own ? undefined : row.model}
            inline
            beside={
              <EffortSelect
                title={spadeRoleNames[row.role]}
                value={data.ownEfforts[row.role]}
                none={effortFollows(data.ownEfforts[row.role] ? undefined : row.effort)}
                save={(effort) => change({ efforts: { [row.role]: effort } })}
              />
            }
            save={(model) => change({ roles: { [row.role]: model } })}
          />
        );
      })}
      <RetrySwitchRow
        title="Retry failed helpers on its own model"
        on={data.escalate}
        save={(on) => change({ escalate: on })}
      />
    </>
  );
}
