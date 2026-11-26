import { ProfileApps } from "./spade-bot-connectors.tsx";
import { ProfilePlugins } from "./spade-bot-plugins.tsx";
import { ProfilePermissionSwitches } from "./spade-profile-permissions.tsx";
import { ProfileContracts } from "./spade-profile-contracts.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

/** What the bot may use: its permission switches, apps, plugins and the contracts it keeps. */
export function ProfileSwitchesAndApps(props: { bot: RosterBot }) {
  return (
    <>
      <ProfilePermissionSwitches bot={props.bot} />
      <ProfileApps bot={props.bot} />
      <ProfilePlugins bot={props.bot} />
      <ProfileContracts bot={props.bot} />
    </>
  );
}
