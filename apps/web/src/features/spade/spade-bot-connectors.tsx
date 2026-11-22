import type { SpadeConnector, SpadeConnectorAccess } from "@ace/ui-core/spade-chat";
import { PlusIcon } from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SettingAction } from "@/components/setting-row.tsx";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { Button } from "@/components/ui/button.tsx";
import { FloatingContents } from "@/components/ui/floating-material.tsx";
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
import { removeGrant, securityKey, useBotSecurity } from "./spade-security-api.ts";
import { fault } from "./spade-profile-actions.ts";
import { ProfileProblem, ProfileSection, rowPill } from "./spade-profile-parts.tsx";
import { SuggestedApps } from "./spade-suggested-apps.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** The connected apps this bot may use, by the allow list: all of them, or the ones named. */
function allowedOf(access: SpadeConnectorAccess, connectors: readonly SpadeConnector[]) {
  return access.all
    ? connectors
    : connectors.filter((connector) => access.connectors.includes(connector.id));
}

/**
 * Apps (ADR 0131), a section of Details: one row per connected app this bot may use, its account
 * under it, with Remove; then Add an app, a menu of the connected apps it doesn't have yet, by
 * name (no new sign-in) and a way to connect another; then the apps that fit its task, each
 * a click from connected (ADR 0131, amendment 1). An app whose changes the person allowed always
 * for this bot says so on its row, with Ask again to take that back (ADR 0202, amendment 5).
 * Each change is saved as it is made. Spade may use every app unless
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
  // "Always allow for <app>" the person gave this bot (ADR 0202, amendment 5), revoked here.
  const security = useBotSecurity(bot.id);
  const appGrants = (app: string) =>
    security.data?.grants.filter(
      (grant) => grant.kind === "app" && grant.app === app && grant.writes,
    ) ?? [];
  const alwaysFor = (app: string) => appGrants(app).length > 0;
  const askAgain = async (app: string) => {
    const grants = appGrants(app);
    if (!grants.length) return;
    setSaving(true);
    setProblem(undefined);
    try {
      for (const grant of grants) await removeGrant(client, bot.id, grant.id);
      await cache.invalidateQueries({ queryKey: securityKey });
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
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
  // Only apps it can be given now: one still signing in has nothing to give until it finishes.
  const others = connectors.filter(
    (connector) => !allowed.includes(connector) && connector.state !== "signing_in",
  );
  return (
    <ProfileSection label="Apps">
      {allowed.map((connector) => (
        <div
          key={connector.id}
          data-setting-slot=""
          {...part("list-row", undefined, "connector")}
          className="flex min-h-(--setting-row-height) items-center gap-3 py-2"
        >
          <AppMark catalogue={connector.catalogue} name={connector.name} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-ui font-medium text-foreground">{connector.name}</span>
            {connector.account && (
              <span className="truncate text-xs text-subtle-foreground">{connector.account}</span>
            )}
            {alwaysFor(connector.id) && (
              <span className="truncate text-xs text-subtle-foreground">
                Its changes run without asking
              </span>
            )}
          </div>
          {alwaysFor(connector.id) && (
            <Button
              size="sm"
              variant="ghost"
              className={rowPill}
              aria-label={`Ask again before ${bot.name} changes things in ${connector.name}`}
              disabled={saving}
              onClick={() => void askAgain(connector.id)}
            >
              Ask again
            </Button>
          )}
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
      {/* Solid: the menu opens over the rows below it, and glass let them read through it. Its
          own slot keeps the focus guards the open menu adds from drawing a hairline in the card. */}
      <div data-setting-slot="">
        <FloatingContents glass>
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
                  icon={
                    <AppMark catalogue={connector.catalogue} name={connector.name} size="inline" />
                  }
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
        </FloatingContents>
      </div>
      {problem && (
        <p data-setting-slot="" role="alert" className="py-2 text-xs text-destructive">
          {`Couldn't change its apps. ${problem}`}
        </p>
      )}
      {!access.all && bot.task.trim() && (
        <SuggestedApps task={bot.task} botId={bot.id} className="py-3" />
      )}
    </ProfileSection>
  );
}
