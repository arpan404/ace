import { configuredForge, publicForgeHosts, type ForgeKind } from "@ace/protocol/forge";

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

/** The provider a saved host entry names; the same rule settings validation uses. */
export const hostForge = configuredForge;

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

/**
 * The CLI ace reads each provider through. Providers without one can be saved as hosts, but ace
 * can't check their readiness yet.
 */
export const forgeClis: Readonly<Record<ForgeKind, string | undefined>> = {
  github: "gh",
  origin: "origin",
  gitlab: "glab",
  gitbucket: undefined,
  bitbucket: "bkt",
  gitea: "tea",
  forgejo: "tea",
};

/** The command that signs a provider's CLI in, or undefined without a CLI. bkt needs the Cloud
 * host named: on its own, `bkt auth login` asks for a Data Center server. */
export function forgeSignIn(forge: ForgeKind): string | undefined {
  if (forge === "bitbucket") return "bkt auth login https://bitbucket.org --kind cloud --web";
  const cli = forgeClis[forge];
  return cli ? `${cli} auth login` : undefined;
}

/** Whether ace can check a provider's sign-in and API through its CLI. */
export function forgeCanCheck(forge: ForgeKind): boolean {
  return forgeClis[forge] !== undefined;
}
