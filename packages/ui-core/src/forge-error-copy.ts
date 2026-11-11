import type { ForgeKind } from "@ace/protocol/forge";
import { actionErrorText } from "./action-errors.ts";
import { forgeClis, forgeNames } from "./forge-hosts.ts";

/*
 * A failed Git host read in the provider's own words. GitHub keeps the shared action-error table,
 * which names `gh`. Other providers are read-only in ace, so only read failures can reach them:
 * those get sentences that name the provider and its CLI, never GitHub or `gh`. Pure.
 */

function hostedCopy(name: string, cli: string | undefined): Record<string, string> {
  const signIn = cli
    ? `Sign in to ${name}: run \`${cli} auth login\` (install \`${cli}\` first if it's missing), then retry.`
    : `ace can't read ${name} yet: open it on ${name}.`;
  return {
    forge_cli: signIn,
    forge_forbidden: cli
      ? `${name} denied access: check your permissions on the repository, or run \`${cli} auth login\`.`
      : signIn,
    forge_not_found: `${name} couldn't find that repository or review: check its number and your access to the repository.`,
    forge_rate_limit: `${name}'s rate limit was reached: wait a few minutes, then retry.`,
    forge_unsupported: `ace can't show this from ${name} yet: open it on ${name}.`,
    forge_offline: `${name} can't be reached from the daemon: check its connection, then retry.`,
    forge_invalid_data: cli
      ? `${name}'s reply couldn't be read: update \`${cli}\`, then refresh.`
      : `${name}'s reply couldn't be read: refresh.`,
    forge_limit: `${name} returned more than ace can show here: open it on ${name}.`,
    forge_cancelled: `The ${name} request was cancelled: try again.`,
    forge_read_failed: `${name}'s answer couldn't be used: retry, or check the daemon's logs.`,
    forge_head_moved:
      "The review's branch moved since you looked: refresh to read its new changes.",
    pr_unreadable: `ace couldn't read the review from ${name}: refresh, then retry.`,
  };
}

/** The sentence for a read failure on `forge`. Codes without a hosted sentence use the shared one. */
export function forgeErrorText(code: string | undefined, forge: ForgeKind | undefined): string {
  if (!forge || forge === "github") return actionErrorText(code);
  const hosted = code ? hostedCopy(forgeNames[forge], forgeClis[forge])[code] : undefined;
  if (hosted) return hosted;
  // A GitHub-worded write sentence would be wrong here; say it plainly instead.
  if (code?.startsWith("forge_"))
    return `${forgeNames[forge]} couldn't do that from ace: open it on ${forgeNames[forge]}.`;
  return actionErrorText(code);
}
