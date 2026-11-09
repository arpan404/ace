import { publicForgeHosts, type ForgeKind } from "@ace/protocol/forge";

/** Each Git host provider's display name. The one table every client reads. */
export const forgeNames: Readonly<Record<ForgeKind, string>> = {
  github: "GitHub",
  origin: "Cursor Origin",
  gitlab: "GitLab",
  gitbucket: "GitBucket",
  bitbucket: "Bitbucket",
  gitea: "Gitea",
  forgejo: "Forgejo",
};

export function forgeDisplayName(forge: ForgeKind): string {
  return forgeNames[forge];
}

/** The provider a saved host entry names. Entries saved before providers existed are GitHub. */
export function hostForge(entry: { host: string; forge?: ForgeKind | undefined }): ForgeKind {
  return entry.forge ?? publicForgeHosts[entry.host] ?? "github";
}

/** The public host a provider defaults to, or "" for providers that are only self-hosted. */
export function defaultForgeHost(forge: ForgeKind): string {
  return Object.keys(publicForgeHosts).find((host) => publicForgeHosts[host] === forge) ?? "";
}

/** Providers in the order settings lists them. */
export const forgeOrder: readonly ForgeKind[] = [
  "github",
  "origin",
  "gitlab",
  "gitbucket",
  "bitbucket",
  "gitea",
  "forgejo",
];
