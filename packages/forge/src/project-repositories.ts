import { repositoryFromRemote } from "./remote.ts";
import { repositoryKey } from "./repository-key.ts";
export { repositoryKey } from "./repository-key.ts";
import {
  configuredForge,
  configuredForges,
  publicForgeHosts,
  readableForges,
  type ForgeRepository,
} from "@ace/protocol/forge";
import type {
  ProjectRepository,
  ProjectRepositoryConfig,
  ProjectRepositoryUnavailable,
  SourceControlPreferences,
} from "@ace/protocol";

export interface CheckoutRemote {
  name: string;
  fetchUrls: readonly string[];
}
export interface ResolvedProjectRepositories {
  repositories: ProjectRepository[];
  primary: ProjectRepository | undefined;
}

/** The repository a remote's first fetch URL names, or undefined on an unknown host. */
function remoteRepository(
  remote: CheckoutRemote,
  preferences: SourceControlPreferences | undefined,
  aliases: Readonly<Record<string, string>>,
): ForgeRepository | undefined {
  const url = remote.fetchUrls[0];
  if (!url) return undefined;
  try {
    return repositoryFromRemote(
      url,
      preferences ? configuredForges(preferences.hosts) : {},
      aliases,
    );
  } catch {
    return undefined;
  }
}

/** The entry when the project can use it: visible and available. */
const usable = (entry: ProjectRepository | undefined) =>
  entry?.visible && entry.available ? entry : undefined;

/** Why a hand-added repository can't be used with today's host settings, if it can't. */
function manualProblem(
  repository: ForgeRepository,
  preferences: SourceControlPreferences | undefined,
): ProjectRepositoryUnavailable | undefined {
  const host = repository.host.toLowerCase();
  const entry = preferences?.hosts.find((candidate) => candidate.host === host);
  const forge = entry ? configuredForge(entry) : publicForgeHosts[host];
  if (!forge) return "host_not_configured";
  return forge === repository.forge ? undefined : "provider_mismatch";
}

/**
 * A project's repositories (ADR 0116): each remote on a known host, then each repository added
 * by hand, one entry per identity, with the saved hidden and primary choices applied. Pure.
 */
export function resolveProjectRepositories(input: {
  remotes: readonly CheckoutRemote[];
  preferences: SourceControlPreferences | undefined;
  /** SSH host aliases resolved to real hosts, from `SourceControl.hostAliases`. */
  aliases?: Readonly<Record<string, string>>;
  config: ProjectRepositoryConfig | undefined;
}): ResolvedProjectRepositories {
  const { preferences, config } = input;
  const aliases = input.aliases ?? {};
  const preferred = preferences?.remote ?? "origin";
  const hidden = new Set(config?.hidden.map(repositoryKey));
  const entries = new Map<string, ProjectRepository>();
  const add = (
    repository: ForgeRepository,
    source: ProjectRepository["source"],
    remote: string | undefined,
    problem: ProjectRepositoryUnavailable | undefined,
  ) => {
    const key = repositoryKey(repository);
    if (entries.has(key) || entries.size >= 128) return;
    const unavailable =
      problem ?? (readableForges.includes(repository.forge) ? undefined : "provider_unsupported");
    entries.set(key, {
      repository,
      source,
      ...(remote ? { remote } : {}),
      visible: !hidden.has(key),
      primary: false,
      available: unavailable === undefined,
      ...(unavailable ? { unavailable } : {}),
    });
  };
  const ordered = [
    ...input.remotes.filter((remote) => remote.name === preferred),
    ...input.remotes.filter((remote) => remote.name !== preferred),
  ];
  for (const remote of ordered) {
    const repository = remoteRepository(remote, preferences, aliases);
    if (repository) add(repository, "remote", remote.name, undefined);
  }
  for (const repository of config?.added ?? [])
    add(repository, "manual", undefined, manualProblem(repository, preferences));
  if (config?.primary && !entries.has(repositoryKey(config.primary)))
    add(config.primary, "remote", undefined, "remote_missing");
  const at = (repository: ForgeRepository | undefined) =>
    repository ? entries.get(repositoryKey(repository)) : undefined;
  // Today's rule: the global remote name's repository; with no preferences, the first remote.
  const legacyRemote =
    input.remotes.find((remote) => remote.name === preferred) ??
    (preferences ? undefined : input.remotes[0]);
  const legacy = at(legacyRemote && remoteRepository(legacyRemote, preferences, aliases));
  const primary =
    usable(at(config?.primary ?? undefined)) ??
    (legacy?.visible ? legacy : undefined) ??
    (config ? [...entries.values()].find((entry) => usable(entry)) : undefined);
  if (primary) primary.primary = true;
  return { repositories: [...entries.values()], primary };
}

/**
 * Whether the project lets a write reach `repository`: refused when it lists it hidden or
 * unavailable. A repository the project doesn't list (a fork's parent) is not its to refuse.
 */
export function repositoryWriteRefusal(
  resolved: ResolvedProjectRepositories,
  repository: ForgeRepository,
): "repository_hidden" | "repository_unavailable" | undefined {
  const key = repositoryKey(repository);
  const entry = resolved.repositories.find(
    (candidate) => repositoryKey(candidate.repository) === key,
  );
  if (!entry) return undefined;
  if (!entry.visible) return "repository_hidden";
  return entry.available ? undefined : "repository_unavailable";
}

/** Each repository once, by identity, in first-seen order. */
function unique(repositories: readonly ForgeRepository[]): ForgeRepository[] {
  const seen = new Set<string>();
  return repositories.filter((repository) => {
    const key = repositoryKey(repository);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Choices as they are saved: each repository once, and undefined for no choices at all, so a
 * cleared project is exactly one that never chose. A primary that is also hidden is refused.
 */
export function normalizeRepositoryConfig(
  input: ProjectRepositoryConfig | null,
):
  | { ok: true; config: ProjectRepositoryConfig | undefined }
  | { ok: false; error: "primary_hidden" } {
  if (!input) return { ok: true, config: undefined };
  const hidden = unique(input.hidden);
  const primary = input.primary ? repositoryKey(input.primary) : undefined;
  if (primary && hidden.some((repository) => repositoryKey(repository) === primary))
    return { ok: false, error: "primary_hidden" };
  const added = unique(input.added);
  if (!added.length && !hidden.length && !input.primary) return { ok: true, config: undefined };
  return { ok: true, config: { added, hidden, primary: input.primary } };
}

/**
 * Whether two saved choices are the same choices: the same repositories added in the same
 * order, the same ones hidden in any order, and the same primary, by identity. A save that
 * names the choices it started from is refused when the saved ones differ from them.
 */
export function sameRepositoryConfig(
  a: ProjectRepositoryConfig | null | undefined,
  b: ProjectRepositoryConfig | null | undefined,
): boolean {
  const shape = (input: ProjectRepositoryConfig | null | undefined) => {
    const normalized = normalizeRepositoryConfig(input ?? null);
    const config = normalized.ok ? normalized.config : (input ?? undefined);
    if (!config) return "";
    return JSON.stringify([
      config.added.map(repositoryKey),
      config.hidden.map(repositoryKey).toSorted(),
      config.primary ? repositoryKey(config.primary) : null,
    ]);
  };
  return shape(a) === shape(b);
}
