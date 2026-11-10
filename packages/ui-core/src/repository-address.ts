import { repositoryFromRemote } from "@ace/forge/remote";
import {
  configuredForges,
  publicForgeHosts,
  readableForges,
  type ForgeKind,
  type ForgeRepository,
} from "@ace/protocol/forge";
import { forgeDisplayName } from "./forge-hosts.ts";

/*
 * A repository address a person types to add a repository to a project by hand (ADR 0116):
 * https, ssh:// or scp-style SSH, read with the daemon's own remote rule and the configured
 * hosts, so what the field accepts is what the daemon would list. Pure.
 */

export type RepositoryAddress =
  | { kind: "repository"; repository: ForgeRepository }
  | { kind: "empty" }
  /** The address names a host that is neither public nor in source control settings. */
  | { kind: "host_not_configured"; host: string }
  /** The host's provider has no pull request reads in ace yet. */
  | { kind: "provider_unsupported"; forge: ForgeKind }
  | { kind: "invalid" };

/** The host an address names, lowercased, when it has one. */
function hostOf(address: string): string | undefined {
  const scp = /^(?:[\w.-]+@)?([\w.-]+):([^/].*)$/.exec(address);
  if (scp && !address.includes("://")) return scp[1]?.toLowerCase();
  try {
    return new URL(address).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export function parseRepositoryAddress(
  text: string,
  hosts: readonly { host: string; forge?: ForgeKind | undefined }[],
): RepositoryAddress {
  const address = text.trim();
  if (!address) return { kind: "empty" };
  const forges = configuredForges(hosts);
  let repository: ForgeRepository;
  try {
    repository = repositoryFromRemote(address, forges);
  } catch {
    const host = hostOf(address);
    return host && host.includes(".") && !publicForgeHosts[host] && !forges[host]
      ? { kind: "host_not_configured", host }
      : { kind: "invalid" };
  }
  if (!readableForges.includes(repository.forge))
    return { kind: "provider_unsupported", forge: repository.forge };
  return { kind: "repository", repository };
}

/** What's wrong with an address, in a sentence; undefined when it names a repository. */
export function repositoryAddressProblem(address: RepositoryAddress): string | undefined {
  switch (address.kind) {
    case "repository":
    case "empty":
      return undefined;
    case "host_not_configured":
      return `${address.host} isn't one of your Git hosts. Add it in Source control settings first.`;
    case "provider_unsupported":
      return `ace can't read pull requests from ${forgeDisplayName(address.forge)} yet.`;
    case "invalid":
      return "That isn't a repository address. Paste its https or SSH clone address.";
  }
}
