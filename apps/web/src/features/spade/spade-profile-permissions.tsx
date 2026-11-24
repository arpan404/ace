import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SettingCard } from "@/components/setting-row.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { PermissionRows } from "./spade-permissions.tsx";
import { botSecurityKey, setBotPermission, useBotSecurity } from "./spade-security-api.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** The switches, over the default every bot follows. */
export function ProfilePermissionSwitches(props: { bot: RosterBot }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const permissions = useBotSecurity(props.bot.id).data?.permissions;
  if (!permissions) return null;
  return (
    <>
      <p className="mx-1 mb-3 text-ui text-muted-foreground">
        {props.bot.name} uses the default in{" "}
        <Link to="/settings/spade/security" className="underline-offset-2 hover:underline">
          Settings › Spade
        </Link>{" "}
        unless you set its own.
      </p>
      <SettingCard>
        <PermissionRows
          bot
          permissions={permissions}
          save={async (key, on) => {
            const next = await setBotPermission(client, props.bot.id, key, on);
            cache.setQueryData(botSecurityKey(machine, props.bot.id, "bot"), next);
          }}
          under={{
            computer_use: permissions.on.computer_use && (
              <p data-setting-slot="" className="pb-3 text-xs text-muted-foreground">
                It never uses the apps listed under Computer use in Settings › Spade.
              </p>
            ),
          }}
        />
      </SettingCard>
    </>
  );
}
