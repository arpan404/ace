import { z } from "zod";

/**
 * The apps ace cloud signs in to for Spade (ADR 0140, 0141; `spade/docs/cloud.md`): each one's
 * issuer, endpoints, scopes, MCP resource, and the names of the Worker secrets holding its
 * client ID and secret. Never a client ID or secret itself.
 */

const Https = z.url().refine((value) => value.startsWith("https://"), "must be https");
/** Plain http is allowed only to this machine, for the Worker's own tests. */
const LocalOrHttps = z
  .url()
  .refine(
    (value) =>
      value.startsWith("https://") || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(value),
    "must be https",
  );
const SecretName = z.string().regex(/^[A-Z0-9_]{1,128}$/);

function appSchema(address: typeof Https) {
  return z.strictObject({
    /** Spade's catalogue id for it, and the `{app}` in the broker's paths. */
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    name: z.string().min(1),
    issuer: address,
    authorization_response_iss_parameter_supported: z.boolean().default(false),
    authorization_endpoint: address,
    token_endpoint: address,
    /** How the cloud authenticates at the token endpoint (RFC 6749 section 2.3.1). */
    client_auth: z.enum(["client_secret_basic", "client_secret_post"]),
    scopes: z.array(z.string()).default([]),
    /** The MCP server the tokens are for (RFC 8707 `resource`). */
    resource: address,
    client_id_env: SecretName,
    client_secret_env: SecretName,
  });
}

export const App = appSchema(Https);
export type App = z.infer<typeof App>;

function list(app: ReturnType<typeof appSchema>) {
  return z.array(app).superRefine((apps, context) => {
    const ids = new Set<string>();
    for (const each of apps) {
      if (ids.has(each.id)) context.addIssue({ code: "custom", message: `${each.id} twice` });
      ids.add(each.id);
    }
  });
}
const Apps = list(App);
/** `SPADE_CLOUD_APPS`: another list, as JSON, in place of the shipped one (tests, staging). */
const OverrideApps = list(appSchema(LocalOrHttps));

/**
 * The shipped list. Endpoints are from each issuer's live authorization-server metadata and each
 * MCP server's protected-resource metadata, checked 2026-11-12.
 */
export const SHIPPED_APPS: readonly App[] = Apps.parse([
  {
    id: "asana",
    name: "Asana",
    issuer: "https://app.asana.com",
    authorization_endpoint: "https://app.asana.com/-/oauth_authorize",
    token_endpoint: "https://app.asana.com/-/oauth_token",
    client_auth: "client_secret_post",
    scopes: ["default"],
    resource: "https://mcp.asana.com/v2/mcp",
    client_id_env: "SPADE_CLOUD_ASANA_CLIENT_ID",
    client_secret_env: "SPADE_CLOUD_ASANA_CLIENT_SECRET",
  },
  {
    id: "box",
    name: "Box",
    issuer: "https://api.box.com",
    authorization_endpoint: "https://account.box.com/api/oauth2/authorize",
    token_endpoint: "https://api.box.com/oauth2/token",
    client_auth: "client_secret_basic",
    scopes: [],
    resource: "https://mcp.box.com/",
    client_id_env: "SPADE_CLOUD_BOX_CLIENT_ID",
    client_secret_env: "SPADE_CLOUD_BOX_CLIENT_SECRET",
  },
  {
    id: "canva",
    name: "Canva",
    issuer: "https://www.canva.com",
    authorization_endpoint: "https://www.canva.com/api/oauth/authorize",
    token_endpoint: "https://api.canva.com/auth/v1/oauth/token",
    client_auth: "client_secret_basic",
    scopes: [
      "profile:read",
      "design:meta:read",
      "design:content:read",
      "design:content:write",
      "folder:read",
      "folder:write",
      "brandtemplate:meta:read",
      "brandtemplate:content:read",
      "brandtemplate:content:write",
      "comment:read",
      "comment:write",
      "asset:read",
      "asset:write",
      "brandkit:read",
      "help:answers:read",
      "help:answers:write",
    ],
    resource: "https://api.canva.com/connect/v1/mcp",
    client_id_env: "SPADE_CLOUD_CANVA_CLIENT_ID",
    client_secret_env: "SPADE_CLOUD_CANVA_CLIENT_SECRET",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    issuer: "https://mcp.hubspot.com",
    authorization_endpoint: "https://mcp.hubspot.com/oauth/authorize/user",
    token_endpoint: "https://mcp.hubspot.com/oauth/v3/token",
    client_auth: "client_secret_post",
    scopes: [],
    resource: "https://mcp.hubspot.com",
    client_id_env: "SPADE_CLOUD_HUBSPOT_CLIENT_ID",
    client_secret_env: "SPADE_CLOUD_HUBSPOT_CLIENT_SECRET",
  },
]);

/** The client the cloud signs in to an app as. */
export type Client = { id: string; secret: string };
/** An app and its client, when the Worker has both of its secrets. */
export type ConfiguredApp = { app: App; client: Client | undefined };

/**
 * Each app with its client from `env` (Worker secrets). An app missing either secret is listed
 * but signs no one in. `undefined` when `SPADE_CLOUD_APPS` is set but doesn't read: the broker
 * then has no apps rather than the wrong ones.
 */
export function configureApps(env: Record<string, unknown>): ConfiguredApp[] | undefined {
  const override = env.SPADE_CLOUD_APPS;
  let apps: readonly App[] = SHIPPED_APPS;
  if (typeof override === "string" && override.trim() !== "") {
    try {
      apps = OverrideApps.parse(JSON.parse(override));
    } catch {
      return undefined;
    }
  }
  const value = (name: string) => {
    const found = env[name];
    return typeof found === "string" && found.trim() !== "" ? found.trim() : undefined;
  };
  return apps.map((app) => {
    const id = value(app.client_id_env);
    const secret = value(app.client_secret_env);
    return { app, client: id && secret ? { id, secret } : undefined };
  });
}
