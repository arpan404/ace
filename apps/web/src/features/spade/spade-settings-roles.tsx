import {
  spadeRoleNames,
  spadeRoleNeedsTools,
  spadeRoles,
  type SpadeGlobalRoles,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { oversightKey } from "./spade-oversight-api.ts";
import {
  readGlobalRoles,
  rolesKey,
  setGlobalRoles,
  type SpadeRolesChange,
} from "./spade-roles-api.ts";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { CouldNotRead, fault, Refusal } from "./spade-settings-rows.tsx";
import { EffortSelect, effortDefault } from "./spade-settings-effort.tsx";
import { RouteSettingRow } from "./spade-settings-route.tsx";

/**
 * Settings › Spade › Models › Roles (ADR 0162): the model every bot uses for
 * each role unless it sets its own. Unset, a role takes the fast model (checking done: the
 * strongest model the person uses), which its picker shows. Reviewing steps is the review's
 * model, set here and only here. Each role is a route (ADR 0205 §2): up to four models in order,
 * the next serving when one can't answer; Bots' fallbacks is what every bot's own model falls
 * back to. Beside each model, how hard it thinks (ADR 0213), and a row for the bots' own turns.
 * Then whether a failed helper runs again on the bot's own model.
 */
export function GlobalRoles(props: { fastModel: string | undefined }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const key = [...rolesKey, machine];
  const roles = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readGlobalRoles(client, signal),
  });
  const label = "Roles";
  const change = async (next: SpadeRolesChange) => {
    cache.setQueryData<SpadeGlobalRoles>(key, await setGlobalRoles(client, next));
    // Each bot's roles follow these, and the review's model is the review's own setting.
    await cache.invalidateQueries({ queryKey: rolesKey });
    if (next.roles && "review" in next.roles)
      await cache.invalidateQueries({ queryKey: oversightKey });
  };
  if (!roles.data)
    return (
      <SettingSection label={label}>
        {roles.isError ? (
          <CouldNotRead
            what={label.toLowerCase()}
            error={roles.error}
            retry={() => void roles.refetch()}
          />
        ) : (
          <LoadingRows label={label} rows={5} />
        )}
      </SettingSection>
    );
  const set = roles.data.roles;
  const routes = roles.data.routes;
  const { efforts, effortDefaults } = roles.data;
  const fast = props.fastModel;
  return (
    <SettingSection label={label}>
      <SettingRow title="Bots' own turns" density="compact">
        <EffortSelect
          title="Bots' own turns"
          value={efforts.main}
          none={effortDefault(effortDefaults.main)}
          save={(effort) => change({ efforts: { main: effort } })}
        />
      </SettingRow>
      <RouteSettingRow
        title="Bots' fallbacks"
        description={
          routes.main?.length
            ? undefined
            : "When a bot's own model can't answer, it runs on these, in order"
        }
        route={routes.main ?? []}
        none="None"
        forBots
        save={(route) => change({ roles: { main: route } })}
      />
      {spadeRoles.map((role) => {
        const strongest = role === "verify";
        // Tasks run on each bot's own model and effort until set (ADR 0217 §8a), never the
        // fast one: a task is the chat's own work, moved beside it.
        const chat = role === "task";
        return (
          <RouteSettingRow
            key={role}
            title={spadeRoleNames[role]}
            description={
              set[role] || strongest
                ? undefined
                : chat
                  ? "Default: each bot's own model, as its chat"
                  : fast
                    ? "Default: the fast model"
                    : "Default: each bot's own model"
            }
            route={routes[role] ?? []}
            none={
              strongest
                ? "Strongest model"
                : chat
                  ? "Same as the chat"
                  : fast
                    ? "Fast model"
                    : "Each bot's own"
            }
            follows={strongest || chat ? undefined : fast}
            forBots={spadeRoleNeedsTools(role)}
            beside={
              <EffortSelect
                title={spadeRoleNames[role]}
                value={efforts[role]}
                none={effortDefault(
                  effortDefaults[role] ?? (chat ? effortDefaults.main : undefined),
                )}
                save={(effort) => change({ efforts: { [role]: effort } })}
              />
            }
            save={(route) => change({ roles: { [role]: route } })}
          />
        );
      })}
      <RetrySwitchRow
        title="Retry failed helpers on the bot's own model"
        on={roles.data.escalate}
        save={(on) => change({ escalate: on })}
      />
    </SettingSection>
  );
}

/** Whether a failed helper runs once more on the bot's own model; a refusal says why under it. */
export function RetrySwitchRow(props: {
  title: string;
  on: boolean;
  save(on: boolean): Promise<unknown>;
}) {
  const id = useId();
  const [refusal, setRefusal] = useState<string>();
  const [saving, setSaving] = useState(false);
  return (
    <SettingRow
      title={props.title}
      description={refusal && <Refusal>{refusal}</Refusal>}
      htmlFor={id}
      density="compact"
      inline
    >
      <Switch
        id={id}
        checked={props.on}
        disabled={saving}
        onCheckedChange={(checked) => {
          setSaving(true);
          setRefusal(undefined);
          void props
            .save(checked)
            .catch((error: unknown) => setRefusal(fault(error)))
            .finally(() => setSaving(false));
        }}
      />
    </SettingRow>
  );
}
