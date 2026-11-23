import {
  parseSpadeBotSecurity,
  spadePermissionSwitches,
  type SpadeBotSecurity,
  type SpadePermissionKey,
} from "@ace/ui-core/spade-chat";

/*
 * A bot's Permissions tab on the iPhone (ADR 0171, amendment 7), as web's: what the bot may
 * reach, one switch each, over the default in Settings › Spade › Security. Each row says whether
 * the bot sets it itself or follows that default. Under Computer use one line points to the apps
 * bots never use. A Spade before Permissions answers none, which the tab says. Pure.
 */

export interface SpadePermissionRow {
  key: SpadePermissionKey;
  title: string;
  line: string;
  on: boolean;
  /** The bot sets it itself; false follows the default in Settings › Spade › Security. */
  own: boolean;
}

/** The tab's switches in web's order, or null from a Spade before Permissions. */
export type SpadeProfilePermissions = { rows: SpadePermissionRow[] } | null;

export function spadeProfilePermissions(security: SpadeBotSecurity): SpadeProfilePermissions {
  const permissions = security.permissions;
  if (!permissions) return null;
  return {
    rows: spadePermissionSwitches.map((each) => ({
      key: each.key,
      title: each.title,
      line: each.line,
      on: permissions.on[each.key],
      own: permissions.own[each.key],
    })),
  };
}

/** A bot's security answer, read or written, as the tab shows it. */
export function spadePermissionsOf(body: string): SpadeProfilePermissions {
  const security = parseSpadeBotSecurity(body);
  if (!security) throw new Error("Spade's security settings didn't make sense.");
  return spadeProfilePermissions(security);
}
