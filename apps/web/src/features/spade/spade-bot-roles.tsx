import {
  spadeBotRoleNames,
  spadeEffortShortNames,
  spadeMoney,
  spadeModelLabel,
  type SpadeBotRoles,
  type SpadeEffort,
  type SpadeRole,
} from "@ace/ui-core/spade-chat";
import { CaretRightIcon } from "@ace/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingRow } from "@/components/setting-row.tsx";
import { Icon } from "@/components/icon.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { ProfileProblem, ProfileSection, profileRowClass } from "./spade-profile-parts.tsx";
import { readBotRoles, rolesKey, setBotRoles, type SpadeRolesChange } from "./spade-roles-api.ts";
import { EffortSelect, effortFollows } from "./spade-settings-effort.tsx";
import { ModelSettingRow } from "./spade-settings-rows.tsx";
import { RetrySwitchRow } from "./spade-settings-roles.tsx";
import { useSpadeModels } from "./use-spade-models.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** A bot's models for other work (ADR 0162), read and changed; `change` saves and updates the cache. */
export function useBotRoles(bot: { id: string }) {
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
  return { roles, change };
}

/** "Same as main · High": what a role runs on and how hard it thinks, in one short line. */
function roleLine(
  words: { name: string; source: string | undefined } | undefined,
  effort: SpadeEffort | undefined,
) {
  const parts = [
    words ? words.name : "Same as main",
    effort ? spadeEffortShortNames[effort] : undefined,
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Model › Models for other work (ADR 0162): one row per role with its model and how hard it
 * thinks ("Same as main · High"); a row opens its small page (`RolePage`).
 */
export function BotRoleRows(props: { bot: RosterBot; onOpen(role: SpadeRole): void }) {
  const { roles } = useBotRoles(props.bot);
  const endpoints = useSpadeModels(true).data?.endpoints ?? [];
  const sources = {
    endpoints: endpoints.map((endpoint) => ({ endpoint, models: endpoint.models })),
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
  return (
    <ProfileSection label="Models for other work" flush>
      {data.roles.map((row) => {
        const own = data.own[row.role];
        const effort = data.ownEfforts[row.role] ?? row.effort;
        return (
          <button
            key={row.role}
            type="button"
            data-setting-slot=""
            onClick={() => props.onOpen(row.role)}
            className={cn(profileRowClass, "min-h-12 py-2")}
          >
            <span className="shrink-0 text-ui text-foreground">{spadeBotRoleNames[row.role]}</span>
            <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
              {roleLine(
                (own ?? row.model) && (own ?? row.model) !== props.bot.model
                  ? spadeModelLabel(sources, own ?? row.model)
                  : undefined,
                effort,
              )}
            </span>
            <Icon icon={CaretRightIcon} size={13} className="shrink-0 text-subtle-foreground" />
          </button>
        );
      })}
    </ProfileSection>
  );
}

/** One role's page: its model and how hard it thinks, each following Settings until set here. */
export function RolePage(props: { bot: RosterBot; role: SpadeRole }) {
  const { bot, role } = props;
  const { roles, change } = useBotRoles(bot);
  if (roles.isPending) return <ListSkeleton label="this role" shape="row" rows={2} />;
  if (!roles.data)
    return <ProfileProblem text="Couldn't read this role." onRetry={() => void roles.refetch()} />;
  const { data } = roles;
  const row = data.roles.find((each) => each.role === role);
  const own = data.own[role];
  const effort = data.ownEfforts[role];
  const spent = row ? `${spadeMoney(row.monthMicros)} this month` : undefined;
  return (
    <>
      <ProfileSection label={spadeBotRoleNames[role]}>
        <ModelSettingRow
          title="Model"
          description={
            <span className="tabular-nums">
              <span>{spent}</span>
              {!own && (
                <>
                  {" · "}
                  <span>Follows Settings</span>
                </>
              )}
            </span>
          }
          value={own}
          none="Follow Settings"
          follows={own ? undefined : row?.model}
          stacked
          save={(model) => change({ roles: { [role]: model } })}
        />
        <SettingRow title="Thinking" density="compact">
          <EffortSelect
            title={spadeBotRoleNames[role]}
            className="w-full"
            value={effort}
            none={effortFollows(effort ? undefined : row?.effort)}
            save={(next) => change({ efforts: { [role]: next } })}
          />
        </SettingRow>
      </ProfileSection>
      {role === "helper" && (
        <ProfileSection label="When a helper fails">
          <RetrySwitchRow
            title="Retry on its own model"
            on={data.escalate}
            save={(on) => change({ escalate: on })}
          />
        </ProfileSection>
      )}
    </>
  );
}
