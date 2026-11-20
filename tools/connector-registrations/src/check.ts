import {
  BROKER_CALLBACK,
  type BrokerEntry,
  type CloudApp,
  type Identity,
  type LegalSite,
  type PublicConfig,
  type Registry,
} from "./types.ts";

/**
 * The gate: each rule takes the registry and the facts read from the code, and returns one line
 * per disagreement. An empty list means they agree.
 */

function brokers(registry: Registry): BrokerEntry[] {
  return registry.registrations.filter((entry) => entry.kind === "broker");
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return (
    left.size === a.length &&
    right.size === b.length &&
    left.size === right.size &&
    [...left].every((each) => right.has(each))
  );
}

function difference(a: readonly string[], b: readonly string[]): string[] {
  const right = new Set(b);
  return a.filter((each) => !right.has(each));
}

function describe(missing: string[], extra: string[]): string {
  const parts = [];
  if (missing.length) parts.push(`missing ${missing.join(", ")}`);
  if (extra.length) parts.push(`extra ${extra.join(", ")}`);
  return parts.length ? parts.join("; ") : "duplicates";
}

/** Rule 1: every shipped app is covered by exactly one broker registration. */
export function checkCoverage(registry: Registry, apps: readonly CloudApp[]): string[] {
  const problems: string[] = [];
  const shipped = new Set(apps.map((app) => app.id));
  for (const app of apps) {
    const owners = brokers(registry).filter((entry) => entry.apps.includes(app.id));
    if (owners.length === 0) problems.push(`${app.id}: no broker registration covers it`);
    if (owners.length > 1)
      problems.push(`${app.id}: covered by ${owners.map((entry) => entry.id).join(" and ")}`);
  }
  for (const entry of brokers(registry))
    for (const id of entry.apps)
      if (!shipped.has(id)) problems.push(`${entry.id}: ${id} is not in SHIPPED_APPS`);
  return problems;
}

/** Rule 2: a broker registration's redirects are the cloud callbacks for its apps, one each. */
export function checkRedirects(registry: Registry): string[] {
  const problems: string[] = [];
  for (const entry of brokers(registry)) {
    const expected = entry.apps.map((id) => `${BROKER_CALLBACK}${id}`);
    if (!sameSet(entry.redirects, expected))
      problems.push(
        `${entry.id}: redirects differ from the cloud callbacks (${describe(
          difference(expected, entry.redirects),
          difference(entry.redirects, expected),
        )})`,
      );
  }
  return problems;
}

/** Rule 3: a broker registration asks for exactly the scopes its apps ask for. */
export function checkScopes(registry: Registry, apps: readonly CloudApp[]): string[] {
  const problems: string[] = [];
  const byId = new Map(apps.map((app) => [app.id, app]));
  for (const entry of brokers(registry)) {
    const covered = entry.apps.flatMap((id) => byId.get(id) ?? []);
    const expected = [...new Set(covered.flatMap((app) => app.scopes))];
    if (!sameSet(entry.scopes, expected))
      problems.push(
        `${entry.id}: scopes differ from apps.ts (${describe(
          difference(expected, entry.scopes),
          difference(entry.scopes, expected),
        )})`,
      );
  }
  return problems;
}

/** Rule 4: a broker registration names the Worker secrets its apps read, one pair for all. */
export function checkSecrets(registry: Registry, apps: readonly CloudApp[]): string[] {
  const problems: string[] = [];
  const byId = new Map(apps.map((app) => [app.id, app]));
  for (const entry of brokers(registry)) {
    const [idName, secretName] = entry.secrets;
    for (const id of entry.apps) {
      const app = byId.get(id);
      if (!app) continue;
      if (app.client_id_env !== idName || app.client_secret_env !== secretName)
        problems.push(
          `${entry.id}: secrets ${idName}, ${secretName} but ${id} reads ${app.client_id_env}, ${app.client_secret_env}`,
        );
    }
  }
  return problems;
}

/** Rule 5: the public GitHub app matches `connector-apps.json`, and its status its client ID. */
export function checkPublic(registry: Registry, config: PublicConfig): string[] {
  const problems: string[] = [];
  for (const entry of registry.registrations) {
    if (entry.kind !== "public") continue;
    const shipped = config.apps.find((app) => app.connector === entry.id);
    if (!shipped) {
      problems.push(`${entry.id}: no entry in ${entry.client_id_file}`);
      continue;
    }
    if (!sameSet(entry.scopes, shipped.scopes))
      problems.push(
        `${entry.id}: scopes differ from ${entry.client_id_file} (${describe(
          difference(shipped.scopes, entry.scopes),
          difference(entry.scopes, shipped.scopes),
        )})`,
      );
    const hasClient = shipped.client_id.trim() !== "";
    if (entry.status === "approved" && !hasClient)
      problems.push(`${entry.id}: approved but client_id in ${entry.client_id_file} is empty`);
    if (entry.status !== "approved" && hasClient)
      problems.push(
        `${entry.id}: ${entry.client_id_file} has a client_id but the registry says ${entry.status}`,
      );
  }
  return problems;
}

/** Follows `_redirects` from a path, at most a few hops, to where it lands. */
function land(path: string, redirects: ReadonlyMap<string, string>): string {
  let at = path;
  for (let hop = 0; hop < 5; hop += 1) {
    const next = redirects.get(at);
    if (next === undefined) return at;
    at = next;
  }
  return at;
}

/** Rule 6: Spade's privacy and terms URLs reach the legal pages the marketing site declares. */
export function checkLegal(app: Identity, site: LegalSite): string[] {
  const problems: string[] = [];
  const pages = [
    { label: "privacy", url: app.privacy, page: site.privacyPath, source: "privacyPolicy" },
    { label: "terms", url: app.terms, page: site.termsPath, source: "termsOfService" },
  ];
  for (const { label, url, page, source } of pages) {
    if (page === undefined) {
      problems.push(`${label}: legal.ts declares no ${source} path`);
      continue;
    }
    const address = new URL(url);
    if (address.origin !== new URL(app.homepage).origin) {
      problems.push(`${label}: ${url} is not on ${app.homepage}`);
      continue;
    }
    const landed = land(address.pathname, site.redirects);
    if (landed !== page)
      problems.push(
        `${label}: ${url} lands on ${landed}, not ${page} (apps/marketing/public/_redirects)`,
      );
  }
  return problems;
}

/** Rule 7: an approved registration waits on nothing, and a blocked one says on what. */
export function checkBlocked(registry: Registry): string[] {
  const problems: string[] = [];
  for (const entry of registry.registrations) {
    if (entry.status === "approved" && entry.blocked_on !== null)
      problems.push(`${entry.id}: approved but still blocked on "${entry.blocked_on}"`);
    if (entry.status === "blocked" && entry.blocked_on === null)
      problems.push(`${entry.id}: blocked without saying on what`);
  }
  return problems;
}

/** The generated checklist matches what the registry renders to. */
export function checkGenerated(
  path: string,
  expected: string,
  actual: string | undefined,
): string[] {
  return expected === actual ? [] : [`${path} is stale: run bun run docs:connectors`];
}

export type Facts = {
  apps: readonly CloudApp[];
  config: PublicConfig;
  site: LegalSite;
};

/** Every rule but the generated-file one, in order. */
export function checkRegistry(registry: Registry, facts: Facts): string[] {
  return [
    ...checkCoverage(registry, facts.apps),
    ...checkRedirects(registry),
    ...checkScopes(registry, facts.apps),
    ...checkSecrets(registry, facts.apps),
    ...checkPublic(registry, facts.config),
    ...checkLegal(registry.app, facts.site),
    ...checkBlocked(registry),
  ];
}
