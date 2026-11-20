import { describe, expect, it } from "vitest";
import { SHIPPED_APPS } from "@ace/cloud/apps";
import {
  checkBlocked,
  checkCoverage,
  checkLegal,
  checkPublic,
  checkRedirects,
  checkRegistry,
  checkScopes,
  checkSecrets,
} from "./check.ts";
import { loadFacts, loadRegistry, parseLegalPaths, parseRedirects, repoRoot } from "./registry.ts";
import type { BrokerEntry, CloudApp, Entry, LegalSite, PublicConfig, Registry } from "./types.ts";

const app = {
  name: "Spade",
  homepage: "https://acehq.dev",
  privacy: "https://acehq.dev/privacy",
  terms: "https://acehq.dev/terms",
  description: "Spade.",
  logo: "icon.png",
  contact: "team@example.com",
};

function broker(overrides: Partial<BrokerEntry> & Pick<BrokerEntry, "id" | "apps">): BrokerEntry {
  return {
    name: overrides.id,
    kind: "broker",
    status: "not-started",
    started: null,
    order: 1,
    minutes: 5,
    blocked_on: null,
    notes: [],
    redirects: overrides.apps.map((id) => `https://cloud.acehq.dev/v1/oauth/callback/${id}`),
    scopes: [],
    secrets: ["A_ID", "A_SECRET"],
    console: "https://example.com/console",
    where: "Console.",
    ...overrides,
  };
}

const github: Entry = {
  id: "github",
  name: "GitHub",
  kind: "public",
  status: "not-started",
  started: null,
  order: 50,
  minutes: 5,
  blocked_on: null,
  notes: [],
  redirects: ["http://127.0.0.1/v1/connectors/callback/github"],
  scopes: ["repo", "gist"],
  console: "https://github.com/settings/applications/new",
  where: "Settings.",
  client_id_file: "spade/config/connector-apps.json",
  device_flow: true,
};

function registry(...registrations: Entry[]): Registry {
  return { about: "test", app, registrations };
}

const cloud = (id: string, scopes: string[] = [], secrets = ["A_ID", "A_SECRET"]): CloudApp => ({
  id,
  scopes,
  client_id_env: secrets[0] ?? "",
  client_secret_env: secrets[1] ?? "",
});

const config = (client_id: string, scopes = ["repo", "gist"]): PublicConfig => ({
  apps: [{ connector: "github", client_id, scopes }],
});

describe("the registry agrees with the code", () => {
  it("passes for the checked-in registry, apps.ts and connector-apps.json", async () => {
    const problems = checkRegistry(await loadRegistry(repoRoot), await loadFacts(repoRoot));
    expect(problems).toEqual([]);
  });

  it("names the Google registration for all seven Google apps", async () => {
    const google = (await loadRegistry(repoRoot)).registrations.find(
      (entry) => entry.id === "google",
    );
    const ids = SHIPPED_APPS.map((each) => each.id).filter(
      (id) => id === "gmail" || id.startsWith("google-"),
    );
    expect(google?.kind === "broker" ? google.apps.toSorted() : []).toEqual(ids.toSorted());
  });
});

describe("coverage", () => {
  it("fails when a shipped app has no registration", () => {
    const problems = checkCoverage(registry(broker({ id: "a", apps: ["a"] })), [
      cloud("a"),
      cloud("b"),
    ]);
    expect(problems).toEqual(["b: no broker registration covers it"]);
  });

  it("fails when two registrations claim one app", () => {
    const problems = checkCoverage(
      registry(broker({ id: "a", apps: ["a"] }), broker({ id: "b", apps: ["a"], order: 2 })),
      [cloud("a")],
    );
    expect(problems).toEqual(["a: covered by a and b"]);
  });

  it("fails when a registration names an app the cloud doesn't ship", () => {
    const problems = checkCoverage(registry(broker({ id: "a", apps: ["a", "gone"] })), [
      cloud("a"),
    ]);
    expect(problems).toEqual(["a: gone is not in SHIPPED_APPS"]);
  });
});

describe("redirects", () => {
  const cloudUrl = "https://cloud.acehq.dev";

  it("fails on a redirect with the wrong app in its path", () => {
    const entry = broker({
      id: "g",
      apps: ["gmail", "google-docs"],
      redirects: [
        "https://cloud.acehq.dev/v1/oauth/callback/gmail",
        "https://cloud.acehq.dev/v1/oauth/callback/google-doc",
      ],
    });
    expect(checkRedirects(registry(entry), cloudUrl)).toEqual([
      "g: redirects differ from the cloud callbacks (missing https://cloud.acehq.dev/v1/oauth/callback/google-docs; extra https://cloud.acehq.dev/v1/oauth/callback/google-doc)",
    ]);
  });

  it("fails when wrangler.jsonc's production origin changes", () => {
    const entry = broker({ id: "a", apps: ["a"] });
    expect(checkRedirects(registry(entry), "https://new-cloud.acehq.dev/")).toEqual([
      "a: redirects differ from the cloud callbacks (missing https://new-cloud.acehq.dev/v1/oauth/callback/a; extra https://cloud.acehq.dev/v1/oauth/callback/a)",
    ]);
  });

  it("fails on a redirect listed twice", () => {
    const callback = "https://cloud.acehq.dev/v1/oauth/callback/a";
    const entry = broker({ id: "a", apps: ["a"], redirects: [callback, callback] });
    expect(checkRedirects(registry(entry), cloudUrl)).toHaveLength(1);
  });

  it("passes when the redirects match in another order", () => {
    const entry = broker({ id: "g", apps: ["a", "b"] });
    entry.redirects.reverse();
    expect(checkRedirects(registry(entry), cloudUrl)).toEqual([]);
  });
});

describe("scopes", () => {
  it("fails on a stale scope the cloud no longer asks for", () => {
    const entry = broker({ id: "a", apps: ["a"], scopes: ["read", "write"] });
    expect(checkScopes(registry(entry), [cloud("a", ["read"])])).toEqual([
      "a: scopes differ from apps.ts (extra write)",
    ]);
  });

  it("takes the union of every covered app's scopes", () => {
    const entry = broker({ id: "g", apps: ["a", "b"], scopes: ["one", "two"] });
    expect(checkScopes(registry(entry), [cloud("a", ["one"]), cloud("b", ["two"])])).toEqual([]);
    expect(checkScopes(registry(entry), [cloud("a", ["one"]), cloud("b", ["three"])])).toEqual([
      "g: scopes differ from apps.ts (missing three; extra two)",
    ]);
  });

  it("keeps an app with the maker's own scopes empty", () => {
    const entry = broker({ id: "box", apps: ["box"], scopes: ["root_readwrite"] });
    expect(checkScopes(registry(entry), [cloud("box")])).toEqual([
      "box: scopes differ from apps.ts (extra root_readwrite)",
    ]);
  });
});

describe("secrets", () => {
  it("fails when one of a shared registration's apps reads another pair", () => {
    const entry = broker({ id: "g", apps: ["a", "b"], secrets: ["G_ID", "G_SECRET"] });
    const apps = [cloud("a", [], ["G_ID", "G_SECRET"]), cloud("b", [], ["B_ID", "G_SECRET"])];
    expect(checkSecrets(registry(entry), apps)).toEqual([
      "g: secrets G_ID, G_SECRET but b reads B_ID, G_SECRET",
    ]);
  });
});

describe("the public GitHub app", () => {
  it("fails when the registry says approved but no client ID shipped", () => {
    const approved = { ...github, status: "approved" as const };
    expect(checkPublic(registry(approved), config(""))).toEqual([
      "github: approved but client_id in spade/config/connector-apps.json is empty",
    ]);
  });

  it("fails when a client ID shipped but the registry isn't approved", () => {
    expect(checkPublic(registry(github), config("Iv1.abc"))).toEqual([
      "github: spade/config/connector-apps.json has a client_id but the registry says not-started",
    ]);
  });

  it("fails when its scopes drift from connector-apps.json", () => {
    expect(checkPublic(registry(github), config("", ["repo"]))).toEqual([
      "github: scopes differ from spade/config/connector-apps.json (extra gist)",
    ]);
  });
});

describe("legal URLs", () => {
  const legal = parseLegalPaths(
    'export const privacyPolicy: LegalDocument = {\n  path: "/privacy-policy/",\n};\n' +
      'export const termsOfService: LegalDocument = {\n  path: "/terms-of-service/",\n};\n',
  );
  const site = (redirects: string): LegalSite => ({
    ...legal,
    redirects: parseRedirects(redirects),
  });

  it("passes when _redirects routes both short URLs to the declared pages", () => {
    const rules = "# short\n/privacy /privacy-policy/ 301\n/terms /terms-of-service/ 301\n";
    expect(checkLegal(app, site(rules))).toEqual([]);
  });

  it("fails when a short URL has no redirect", () => {
    expect(checkLegal(app, site("/privacy /privacy-policy/ 301\n"))).toEqual([
      "terms: https://acehq.dev/terms lands on /terms, not /terms-of-service/ (apps/marketing/public/_redirects)",
    ]);
  });

  it("fails when the privacy URL goes to the terms page", () => {
    const rules = "/privacy /terms-of-service/ 301\n/terms /terms-of-service/ 301\n";
    expect(checkLegal(app, site(rules))).toEqual([
      "privacy: https://acehq.dev/privacy lands on /terms-of-service/, not /privacy-policy/ (apps/marketing/public/_redirects)",
    ]);
  });

  it("fails when legal.ts no longer declares a page", () => {
    const rules = "/privacy /privacy-policy/ 301\n/terms /terms-of-service/ 301\n";
    expect(checkLegal(app, { ...site(rules), termsPath: undefined })).toEqual([
      "terms: legal.ts declares no termsOfService path",
    ]);
  });
});

describe("blocked and approved", () => {
  it("fails when an approved registration is still blocked", () => {
    const entry = broker({ id: "a", apps: ["a"], status: "approved", blocked_on: "review" });
    expect(checkBlocked(registry(entry))).toEqual(['a: approved but still blocked on "review"']);
  });

  it("fails when a blocked registration doesn't say on what", () => {
    const entry = broker({ id: "a", apps: ["a"], status: "blocked" });
    expect(checkBlocked(registry(entry))).toEqual(["a: blocked without saying on what"]);
  });
});
