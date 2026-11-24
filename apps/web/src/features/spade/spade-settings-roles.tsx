import {
  spadeRoleNames,
  spadeRoleNeedsTools,
  spadeRoles,
  type SpadeGlobalRoles,
  type SpadeRole,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
  SettingCard,
  SettingRow,
  SettingsGroupTitle,
  settingsGroup,
} from "@/components/setting-row.tsx";
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
import { roleGridColumns, RouteSettingRow } from "./spade-settings-route.tsx";

const roleHints: Record<SpadeRole, string> = {
  task: "Work spun off beside the chat",
  helper: "Small background tool steps",
  verify: "Checks finished work before stopping",
  review: "Reviews writes before they run",
  compact: "Compacts long conversations",
  title: "Names new conversations",
};

/**
 * Settings › Spade › Models › Roles (ADR 0162, ADR 0205 §2, ADR 0213):
 * split into two clean cards inside the Roles section — bot-wide defaults (own turns,
 * fallback chain, helper retry) and the aligned Role | Model | Thinking table for each
 * specialized role.
 */
export function GlobalRoles(props: { fastModel: string | undefined }) {
  const headingId = useId();
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
  return (
    <section
      id="roles"
      data-part="settings-section"
      className={settingsGroup}
      aria-labelledby={headingId}
    >
      <SettingsGroupTitle
        id={headingId}
        note={roles.data ? "Defaults every bot inherits unless it sets its own." : undefined}
      >
        {label}
      </SettingsGroupTitle>
      {!roles.data ? (
        <SettingCard>
          {roles.isError ? (
            <CouldNotRead
              what={label.toLowerCase()}
              error={roles.error}
              retry={() => void roles.refetch()}
            />
          ) : (
            <LoadingRows label={label} rows={5} />
          )}
        </SettingCard>
      ) : (
        <LoadedRoles data={roles.data} fastModel={props.fastModel} change={change} />
      )}
    </section>
  );
}

function LoadedRoles(props: {
  data: SpadeGlobalRoles;
  fastModel: string | undefined;
  change(next: SpadeRolesChange): Promise<void>;
}) {
  const { data, fastModel: fast, change } = props;
  const { routes, efforts, effortDefaults } = data;
  return (
    <>
      <SettingCard>
        <SettingRow
          title="Bots' own turns"
          description="How hard bots think when answering directly"
          density="compact"
        >
          <EffortSelect
            title="Bots' own turns"
            className="w-52"
            value={efforts.main}
            none={effortDefault(effortDefaults.main)}
            save={(effort) => change({ efforts: { main: effort } })}
          />
        </SettingRow>
        <RouteSettingRow
          title="Bots' fallbacks"
          description="Backup models used in order when a bot's own model can't answer"
          route={routes.main ?? []}
          none="None"
          forBots
          save={(route) => change({ roles: { main: route } })}
        />
        <RetrySwitchRow
          title="Retry failed helpers on the bot's own model"
          description="Escalate to the bot's main model if a helper step fails"
          on={data.escalate}
          save={(on) => change({ escalate: on })}
        />
      </SettingCard>

      <SettingCard className="mt-3">
        <div
          aria-hidden
          className="@container hidden py-2.5 text-xs font-medium text-muted-foreground sm:block"
        >
          <div className={roleGridColumns}>
            <span>Role</span>
            <span>Model</span>
            <span>Thinking</span>
          </div>
        </div>
        {spadeRoles.map((role) => {
          const strongest = role === "verify";
          // Tasks run on each bot's own model and effort until set (ADR 0217 §8a), never the
          // fast one: a task is the chat's own work, moved beside it.
          const chat = role === "task";
          return (
            <RouteSettingRow
              key={role}
              title={spadeRoleNames[role]}
              description={roleHints[role]}
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
                  className="w-full"
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
      </SettingCard>
    </>
  );
}

/** Whether a failed helper runs once more on the bot's own model; a refusal says why under it. */
export function RetrySwitchRow(props: {
  title: string;
  description?: string | undefined;
  on: boolean;
  save(on: boolean): Promise<unknown>;
}) {
  const id = useId();
  const [refusal, setRefusal] = useState<string>();
  const [saving, setSaving] = useState(false);
  return (
    <SettingRow
      title={props.title}
      description={refusal ? <Refusal>{refusal}</Refusal> : props.description}
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
