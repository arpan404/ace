import { repositoryKey } from "@ace/forge/project-repositories";
import { repositoryFromRemote } from "@ace/forge/remote";
import { publicForgeHosts } from "@ace/protocol/forge";
import type {
  ForgeKind,
  ForgeRepository,
  ProjectRepository,
  ProjectRepositoryUnavailable,
} from "@ace/protocol";
import { forgeDisplayName } from "./forge-hosts.ts";

/*
 * The words and parsing a project's repository settings share (ADR 0116): a repository added by
 * its address, why a listed one can't be used, and the daemon's refusals of a save. Pure.
 */

const hostOf = (address: string): string | undefined => {
  const scp = /^(?:[\w.-]+@)?([\w.-]+):([^/].*)$/.exec(address);
  if (scp && !address.includes("://")) return scp[1]?.toLowerCase();
  try {
    return new URL(address).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * A repository from the address a person typed (https or SSH), read by the same rule as the
 * checkout's remotes. `hosts` are the configured hosts' providers (`configuredForges`).
 */
export function repositoryFromAddress(
  address: string,
  hosts: Readonly<Record<string, ForgeKind>>,
): { ok: true; repository: ForgeRepository } | { ok: false; problem: string } {
  const value = address.trim();
  if (!value) return { ok: false, problem: "Enter the repository's address." };
  if (/\s/.test(value))
    return { ok: false, problem: "An address has no spaces. Paste it as Git shows it." };
  const host = hostOf(value);
  if (host && !publicForgeHosts[host] && !hosts[host])
    return {
      ok: false,
      problem: `${host} isn't one of your Git hosts. Add it in Settings under Source control first.`,
    };
  try {
    return { ok: true, repository: repositoryFromRemote(value, hosts) };
  } catch {
    return {
      ok: false,
      problem:
        "That isn't a repository address. Use one like https://github.com/owner/name or git@github.com:owner/name.git.",
    };
  }
}

/** Two repositories are one when provider, host, owner and name match, without case. */
export const sameRepository = (a: ForgeRepository, b: ForgeRepository): boolean =>
  repositoryKey(a) === repositoryKey(b);

/** Why a listed repository can't be used now, in a short sentence. */
export function repositoryUnavailableText(
  reason: ProjectRepositoryUnavailable,
  repository: ForgeRepository,
): string {
  switch (reason) {
    case "host_not_configured":
      return `${repository.host} isn't one of your Git hosts any more`;
    case "provider_mismatch":
      return `${repository.host} is set up as another provider now`;
    case "provider_unsupported":
      return `ace can't read reviews from ${forgeDisplayName(repository.forge)} yet`;
    case "remote_missing":
      return "No remote names it any more";
  }
}

/** The quiet line under a repository: where it comes from, why it can't be used, if it's hidden. */
export function repositoryLine(entry: ProjectRepository): string {
  const parts = [
    entry.source === "remote" && entry.remote ? `Remote ${entry.remote}` : "Added by hand",
  ];
  if (entry.unavailable) parts.push(repositoryUnavailableText(entry.unavailable, entry.repository));
  if (!entry.visible) parts.push("Hidden");
  return parts.join(" · ");
}

const refusals: Readonly<Record<string, string>> = {
  primary_hidden: "The primary repository can't be hidden. Make another one primary first.",
  chat_project: "A chat has no repositories to choose.",
  workspace_not_found: "That project is gone.",
  repository_hidden: "This project hides that repository. Show it in the project's settings first.",
  repository_unavailable: "That repository can't be used now. Check the project's repositories.",
};

/** The daemon's refusal of a repository choice, in words; undefined for a code it doesn't name. */
export function repositoryRefusalText(code: string | undefined): string | undefined {
  return code ? refusals[code] : undefined;
}
