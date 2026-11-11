import {
  ForgePrRef,
  ForgeRepository,
  configuredForge,
  originApiHost,
  publicForgeHosts,
  type ForgeKind,
} from "@ace/protocol/forge";
import { repositoryFromRemote } from "./remote.ts";
import { ForgeError } from "./errors.ts";

/**
 * A host a PR address may name. A bare host string has the public host's provider, or none
 * known (its address shape decides); an entry from settings names its provider.
 */
export type PrHost = string | { host: string; forge?: ForgeKind | undefined };

const defaultHosts: readonly PrHost[] = ["github.com", "gitlab.com", originApiHost];

/** The provider `hostname` has among `hosts`: null when unlisted, undefined when unknown. */
function hostProvider(hosts: readonly PrHost[], hostname: string): ForgeKind | undefined | null {
  for (const entry of hosts) {
    if (typeof entry === "string") {
      if (entry.toLowerCase() === hostname) return publicForgeHosts[hostname];
    } else if (entry.host.toLowerCase() === hostname) return configuredForge(entry);
  }
  return null;
}

/** Only an HTTPS PR address, never a credential-bearing or arbitrary remote URL. The host's
 * configured or public provider decides how the path reads; the path shape decides only for a
 * listed host whose provider isn't known. */
export function prFromUrl(value: string, hosts: readonly PrHost[] = defaultHosts): ForgePrRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ForgeError("invalid_data");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new ForgeError("invalid_data");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "cursor.com") {
    const origin = /^\/codebase\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (!origin) throw new ForgeError("invalid_data");
    return ForgePrRef.parse({
      repository: { forge: "origin", host: originApiHost, owner: origin[1], name: origin[2] },
      number: Number(origin[3]),
    });
  }
  const forge = hostProvider(hosts, hostname);
  if (forge === null) throw new ForgeError("invalid_data");
  const gitlab = /^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (gitlab && (forge === "gitlab" || forge === undefined)) {
    const parts = (gitlab[1] ?? "").split("/");
    const name = parts.pop();
    return ForgePrRef.parse({
      repository: { forge: "gitlab", host: hostname, owner: parts.join("/"), name },
      number: Number(gitlab[2]),
    });
  }
  const github =
    /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|checks|commits))?\/?$/.exec(
      url.pathname,
    );
  if (github && (forge === "github" || forge === undefined))
    return ForgePrRef.parse({
      repository: { forge: "github", host: hostname, owner: github[1], name: github[2] },
      number: Number(github[3]),
    });
  throw new ForgeError("invalid_data");
}

/**
 * A repository named as `owner/name`, `host/owner/name` or (GitLab) `group/subgroup/name`,
 * relative to `fallback`. Another host takes its configured or public provider from `hosts`.
 */
export function prRepository(
  value: string,
  fallback: ForgeRepository,
  hosts: readonly PrHost[] = [],
): ForgeRepository {
  const parts = value.split("/");
  if (
    fallback.forge === "gitlab" &&
    parts.length >= 2 &&
    !parts[0]?.includes(".") &&
    parts[0] !== fallback.host
  ) {
    return ForgeRepository.parse({
      ...fallback,
      owner: parts.slice(0, -1).join("/"),
      name: parts.at(-1),
    });
  }
  if (parts.length !== 2 && parts.length !== 3) throw new ForgeError("invalid_data");
  const host = parts.length === 3 ? (parts[0] ?? "").toLowerCase() : fallback.host;
  const owner = parts.at(-2) ?? "";
  const name = parts.at(-1) ?? "";
  if (host === fallback.host) return ForgeRepository.parse({ ...fallback, owner, name });
  const forge = hostProvider(hosts, host) ?? publicForgeHosts[host];
  if (!forge) throw new ForgeError("invalid_data");
  return repositoryFromRemote(`https://${host}/${owner}/${name}.git`, { [host]: forge });
}

/** A pull request's canonical web address, built from its repository and never from a server's
 * own URL, which may name another host or carry credentials. */
export function prUrl(pr: ForgePrRef): string {
  const repo = pr.repository;
  if (repo.forge === "origin")
    return `https://cursor.com/codebase/${repo.owner}/${repo.name}/pull/${pr.number}`;
  const path =
    repo.forge === "github"
      ? "pull"
      : repo.forge === "gitlab"
        ? "-/merge_requests"
        : repo.forge === "gitea" || repo.forge === "forgejo"
          ? "pulls"
          : undefined;
  if (!path) throw new ForgeError("unsupported");
  return `https://${repo.host}/${repo.owner}/${repo.name}/${path}/${pr.number}`;
}

/**
 * Browser-safe issue identity, with the same restrictions as PR addresses: a GitHub
 * `owner/name/issues/N`, or a GitLab `group/…/project/-/issues/N` on a GitLab host in `hosts`.
 */
export function issueFromUrl(
  value: string,
  hosts: readonly PrHost[] = defaultHosts,
): import("@ace/protocol/forge-issues").ForgeIssueRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ForgeError("invalid_data");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new ForgeError("invalid_data");
  const gitlab = /^\/(.+)\/-\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (gitlab) {
    const ref = prFromUrl(`https://${url.host}/${gitlab[1]}/-/merge_requests/${gitlab[2]}`, hosts);
    if (ref.repository.forge !== "gitlab") throw new ForgeError("invalid_data");
    return ref;
  }
  const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (!match || url.hostname !== "github.com") throw new ForgeError("invalid_data");
  return prFromUrl(`https://${url.host}/${match[1]}/${match[2]}/pull/${match[3]}`);
}
