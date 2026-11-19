import type { ForgeKind } from "@ace/protocol/forge";
import type { SourceControlPreferences } from "@ace/protocol";
import { hostForge } from "@ace/ui-core";

/*
 * The edits Settings › Source control makes to the saved preferences. Saving a host and choosing
 * which host's status the page shows are separate: adding or editing a host never changes which
 * one is shown, except that renaming the shown host keeps it shown. Removing a host only drops
 * the entry; threads and local data are never touched.
 */

export interface HostDraft {
  forge: ForgeKind;
  host: string;
  account: string;
}

/**
 * Saves `draft` over the host it was opened from (`original`; undefined when adding one), and
 * the remote. Returns undefined when the host is already another entry.
 */
export function saveHost(
  preferences: SourceControlPreferences,
  original: string | undefined,
  draft: HostDraft,
  remote: string,
): SourceControlPreferences | undefined {
  if (draft.host !== original && preferences.hosts.some((entry) => entry.host === draft.host))
    return undefined;
  const entry = {
    host: draft.host,
    forge: draft.forge,
    ...(draft.account ? { account: draft.account } : {}),
  };
  const at = preferences.hosts.findIndex((saved) => saved.host === original);
  const hosts =
    at === -1
      ? [...preferences.hosts, entry]
      : preferences.hosts.map((saved, index) => (index === at ? entry : saved));
  const host = original === preferences.host ? draft.host : preferences.host;
  return { hosts, host, remote };
}

/** Shows `host`'s status on the page and uses it for requests. */
export function showHost(
  preferences: SourceControlPreferences,
  host: string,
): SourceControlPreferences {
  return { ...preferences, host };
}

/**
 * Drops `host`. The last host can't be removed. When it was the shown host, the page falls back
 * to another host of the same provider, then to GitHub, then to the first one left.
 */
export function removeHost(
  preferences: SourceControlPreferences,
  host: string,
): SourceControlPreferences | undefined {
  const removed = preferences.hosts.find((entry) => entry.host === host);
  const hosts = preferences.hosts.filter((entry) => entry.host !== host);
  const first = hosts[0];
  if (!removed || !first) return undefined;
  if (preferences.host !== host) return { ...preferences, hosts };
  const next =
    hosts.find((entry) => hostForge(entry) === hostForge(removed)) ??
    hosts.find((entry) => hostForge(entry) === "github") ??
    first;
  return { ...preferences, hosts, host: next.host };
}
