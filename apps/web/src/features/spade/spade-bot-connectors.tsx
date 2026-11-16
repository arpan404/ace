import type { SpadeConnector, SpadeConnectorAccess } from "@ace/ui-core/spade-chat";
import { PlusIcon } from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SettingAction } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { part } from "@/lib/suit-part.ts";
import {
  connectorsKey,
  setAccess,
  useConnectorAccess,
  useSpadeConnectors,
} from "./spade-connector-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { ProfileProblem, ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** The connected apps this bot may use, by the allow list: all of them, or the ones named. */
function allowedOf(access: SpadeConnectorAccess, connectors: readonly SpadeConnector[]) {
  return access.all
    ? connectors
    : connectors.filter((connector) => access.connectors.includes(connector.id));
}

/**
 * Apps (ADR 0131), a section of Details: one row per connected app this bot may use, its account
 * under it, with Remove; then Add an app, a menu of the connected apps it doesn't have yet and a
 * way to connect another. Each change is saved as it is made. Spade may use every app unless
 * narrowed; a new bot none until given one.
 */
export function ProfileApps(props: { bot: RosterBot }) {
  const { bot } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const stored = useConnectorAccess(bot.id);
  const catalogue = useSpadeConnectors();
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const connectors = catalogue.data?.connectors ?? [];
  const access = stored.data;
  const save = async (next: SpadeConnectorAccess) => {
    setSaving(true);
    setProblem(undefined);
    try {
      await setAccess(client, bot.id, next);
      await cache.invalidateQueries({ queryKey: connectorsKey });
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
  if (stored.isPending || catalogue.isPending)
    return (
      <ProfileSection label="Apps">
        <ListSkeleton label="apps" shape="row" rows={1} />
      </ProfileSection>
    );
  if (!access || catalogue.isError)
    return (
      <ProfileSection label="Apps">
        <ProfileProblem
          text="Couldn't read its apps."
          onRetry={() => {
            void stored.refetch();
            void catalogue.refetch();
          }}
        />
      </ProfileSection>
    );
  const allowed = allowedOf(access, connectors);
  const others = connectors.filter((connector) => !allowed.includes(connector));
  return (
    <ProfileSection label="Apps">
      {allowed.map((connector) => (
        <div
          key={connector.id}
          data-setting-slot=""
          {...part("list-row", undefined, "connector")}
          className="flex min-h-(--setting-row-height) items-center gap-3 py-2"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-ui font-medium text-foreground">{connector.name}</span>
            {connector.account && (
              <span className="truncate text-xs text-subtle-foreground">{connector.account}</span>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className={`${rowPill} -mr-3`}
            aria-label={`Remove ${connector.name} from ${bot.name}`}
            disabled={saving}
            onClick={() =>
              void save({
                all: false,
                connectors: allowed.filter((each) => each !== connector).map((each) => each.id),
              })
            }
          >
            Remove
          </Button>
        </div>
      ))}
      <Menu>
        <MenuTrigger
          render={
            <SettingAction disabled={saving}>
              <PlusIcon aria-hidden size={14} className="shrink-0" />
              Add an app
            </SettingAction>
          }
        />
        <MenuContent align="start">
          {others.map((connector) => (
            <MenuItem
              key={connector.id}
              // Not signed in yet: nothing to give a bot until the sign-in finishes.
              disabled={connector.state === "signing_in"}
              onClick={() =>
                void save({
                  all: false,
                  connectors: [...allowed, connector].map((each) => each.id),
                })
              }
            >
              {connector.name}
            </MenuItem>
          ))}
          {others.length > 0 && <MenuSeparator />}
          <MenuItem onClick={() => void navigate({ to: "/settings/spade/apps" })}>
            Connect another app…
          </MenuItem>
        </MenuContent>
      </Menu>
      {problem && (
        <p data-setting-slot="" role="alert" className="py-2 text-xs text-destructive">
          {`Couldn't change its apps. ${problem}`}
        </p>
      )}
    </ProfileSection>
  );
}
