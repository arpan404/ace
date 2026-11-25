import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { PermissionRows } from "./spade-permissions.tsx";
import { ProfileCardSkeleton, ProfileProblem, ProfileSection } from "./spade-profile-parts.tsx";
import { botSecurityKey, setBotPermission, useBotSecurity } from "./spade-security-api.ts";
import type { RosterBot } from "./use-spade-roster.ts";

/** The switches, over the default every bot follows. */
export function ProfilePermissionSwitches(props: { bot: RosterBot }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const security = useBotSecurity(props.bot.id);
  if (security.isPending)
    return (
      <ProfileSection label="Permissions" flush>
        <ProfileCardSkeleton label="permissions" rows={4} lines={2} />
      </ProfileSection>
    );
  if (security.isError)
    return (
      <ProfileSection label="Permissions">
        <ProfileProblem
          text="Couldn't read its permissions."
          onRetry={() => void security.refetch()}
        />
      </ProfileSection>
    );
  const permissions = security.data?.permissions;
  if (!permissions) return null;
  return (
    <ProfileSection
      label="Permissions"
      note={
        <>
          {props.bot.name} uses the default in{" "}
          <Link
            to="/settings/spade/security"
            className="text-foreground underline-offset-2 focus-ring hover:underline"
          >
            Settings › Spade
          </Link>{" "}
          unless you set its own.
        </>
      }
    >
      <PermissionRows
        bot
        permissions={permissions}
        save={async (key, on) => {
          const next = await setBotPermission(client, props.bot.id, key, on);
          cache.setQueryData(botSecurityKey(machine, props.bot.id, "bot"), next);
        }}
        under={{
          computer_use: permissions.on.computer_use && (
            <p
              data-setting-slot=""
              className="py-2.5 text-xs leading-relaxed text-muted-foreground"
            >
              It never uses the apps listed under Computer use in Settings › Spade.
            </p>
          ),
        }}
      />
    </ProfileSection>
  );
}
