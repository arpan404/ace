# Spade's own connector apps

Date: 2026-11-12. Which of Asana, Box, Canva, GitHub and HubSpot can let Spade sign in with a
client ID it ships and no secret ([ADR 0137](../../docs/adr/0137-spade-public-connector-apps.md)),
and how the owner registers the ones that can. Every claim below links to the vendor's own
documentation or to its live authorization-server metadata, read on this date.

## Outcome

| App     | How Spade signs in                                | Deciding source                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub  | Device flow with Spade's own OAuth app, no secret | "The `client_secret` is not needed for the device flow" ([authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow))                                                                            |
| Asana   | The person's own client ID and secret (unchanged) | `client_secret` "(required)" at the token endpoint ([Asana OAuth](https://developers.asana.com/docs/oauth)); MCP apps get "a client id and client secret" ([Asana MCP](https://developers.asana.com/docs/integrating-with-asanas-mcp-server))                    |
| Box     | The person's own client ID and secret (unchanged) | The MCP server's credentials are a "Client ID and Client Secret" from the Admin Console ([Box remote MCP](https://developer.box.com/guides/box-mcp/remote/))                                                                                                     |
| Canva   | The person's own client ID and secret (unchanged) | Token requests "must be authenticated" with the client ID and secret and "must come from your backend" ([Canva Connect authentication](https://www.canva.dev/docs/connect/authentication/))                                                                      |
| HubSpot | The person's own client ID and secret (unchanged) | Metadata allows only `client_secret_post`; MCP clients are set up with the connector's "client ID and client secret" ([HubSpot remote MCP](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server)) |

No vendor here offers a browser sign-in (authorization code with PKCE) without a secret, so none
needs the fixed loopback ports a browser sign-in would have needed; Spade's per-connector
callback on any port stays as it is. Spade still supports a shipped browser app (PKCE, no secret,
`http://127.0.0.1:<any port>/v1/connectors/callback/<connector>`) for a vendor that allows one
later.

## Live authorization-server metadata

Read without credentials on 2026-11-12, from the `resource_metadata` each MCP server names in its
`401` challenge. None advertises dynamic client registration, client ID metadata documents, or
`none` among its token endpoint auth methods.

| App     | Issuer and metadata                                                                                                  | Token endpoint auth methods                 | Device authorization endpoint          |
| ------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------- |
| Asana   | `https://app.asana.com` ([metadata](https://app.asana.com/.well-known/oauth-authorization-server))                   | `client_secret_post`, `client_secret_basic` | none                                   |
| Box     | `https://api.box.com` ([metadata](https://api.box.com/.well-known/oauth-authorization-server))                       | `client_secret_basic`, `client_secret_post` | none                                   |
| Canva   | `https://www.canva.com` ([metadata](https://www.canva.com/.well-known/openid-configuration))                         | `client_secret_basic`, `client_secret_post` | none                                   |
| GitHub  | `https://github.com/login/oauth` ([metadata](https://github.com/.well-known/oauth-authorization-server/login/oauth)) | not advertised                              | `https://github.com/login/device/code` |
| HubSpot | `https://mcp.hubspot.com` ([metadata](https://mcp.hubspot.com/.well-known/oauth-authorization-server))               | `client_secret_post`                        | none                                   |

All five advertise PKCE with `S256`. Only GitHub advertises `iss` in authorization responses and
the device grant (`urn:ietf:params:oauth:grant-type:device_code`).

## Per app

### GitHub

- **Public client in the browser:** no. The web flow's token request marks `client_secret`
  "Required", with no exception for PKCE
  ([authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)).
  Its loopback rule would have been fine: "The `redirect_uri` does not need to match the port
  specified in the callback URL", and `127.0.0.1` is preferred over `localhost` (same page).
- **Device flow:** yes, without a secret. Codes come from `POST https://github.com/login/device/code`
  (`client_id`, `scope`), the person enters them at `https://github.com/login/device`, and Spade
  polls `POST https://github.com/login/oauth/access_token` with
  `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Codes last 900 seconds; `interval` is
  the minimum wait between polls and each `slow_down` adds five seconds. GitHub answers poll errors
  with HTTP 200, so Spade reads the `error` field whatever the status. The device flow must be
  turned on in the app's settings (same page).
- **The MCP server accepts the tokens:** `api.githubcopilot.com/mcp/` takes OAuth app tokens,
  GitHub App tokens and personal access tokens; a host using OAuth "must have a registered GitHub
  App (or OAuth App)"
  ([GitHub MCP server policies](https://github.com/github/github-mcp-server/blob/main/docs/policies-and-governance.md)).
  A device-flow token is an ordinary user token for the app.
- **Review:** none for an OAuth app
  ([creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)).
  Organisations that restrict OAuth apps approve it before it can reach their data, and
  organisations on Copilot Business or Enterprise must allow MCP servers.
- **Limit to watch:** "a rate limit of 50 submissions in an hour per application" when people
  enter codes (authorizing OAuth apps). One app shared by every Spade counts against one limit.
- **Tokens:** OAuth app tokens don't expire, so there is no refresh. If the owner registers a
  GitHub App instead, its tokens expire after eight hours and refresh without a secret only
  because they came from the device flow
  ([refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)).
  An OAuth app is the simpler choice; its scopes are the ones the MCP server lists.
- **Scopes Spade asks for:** `repo read:org read:user user:email gist notifications project`
  (from `spade/config/connector-apps.json`), a subset of the MCP server's `scopes_supported`.
- **To confirm on the first real sign-in:** Spade sends the MCP spec's `resource` parameter with
  the device and token requests. GitHub's docs don't list it; if GitHub refuses it, Spade must
  leave it out for this app.

### Asana

- **Public client:** no. `client_secret` is "(required)" at the token endpoint and in refresh
  ([Asana OAuth](https://developers.asana.com/docs/oauth)). PKCE is required for loopback
  redirects but doesn't replace the secret. "Dynamic client registration is not supported with
  Asana's V2 MCP Server", and clients "must still pre-register to get a client id and client
  secret" ([Asana MCP](https://developers.asana.com/docs/integrating-with-asanas-mcp-server)).
- **Device flow:** not offered.
- **Loopback ports:** the redirect must match "exactly"; the docs don't say whether the port may
  vary.
- **Stays on:** "Use your own client ID", an MCP app the person creates in Asana.

### Box

- **Public client:** no. The metadata allows only secret-based client authentication, and the MCP
  docs say to "Copy the generated Client ID and Client Secret"
  ([Box remote MCP](https://developer.box.com/guides/box-mcp/remote/)).
- **Device flow:** not offered.
- **Loopback ports:** for developer-console apps, "Localhost and loopback address redirect URIs
  will be permitted to redirect to any port"
  ([Box OAuth setup](https://developer.box.com/guides/authentication/oauth2/oauth2-setup/)); not
  stated for the MCP credentials an admin makes in the Admin Console.
- **Registration:** per enterprise, by a Box admin; the docs don't say such credentials work in
  other enterprises, so one shipped client may not be possible at all.
- **Stays on:** "Use your own client ID".

### Canva

- **Public client:** no. Token requests "must be authenticated" with the client ID and secret,
  "must come from your backend", and "The code_verifier value must not be accessible by the user
  or their browser" ([Canva Connect authentication](https://www.canva.dev/docs/connect/authentication/)).
  The MCP app "identifies itself using its client ID and secret"
  ([Canva MCP access](https://www.canva.dev/docs/apps/mcp/access/)).
- **Device flow:** not offered.
- **Review:** public apps are reviewed by Canva; private apps are for Enterprise teams
  ([creating integrations](https://www.canva.dev/docs/connect/creating-integrations/)).
- **Stays on:** "Use your own client ID".

### HubSpot

- **Public client:** no. The metadata allows only `client_secret_post`, and the OAuth guide sends
  `client_secret` with both the code exchange and refresh
  ([HubSpot OAuth quickstart](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/oauth-quickstart-guide)).
  PKCE "is required for authenticating with HubSpot's MCP server", alongside the connector's
  "client ID and client secret"
  ([HubSpot remote MCP](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server)).
- **Device flow:** not offered.
- **Stays on:** "Use your own client ID", an MCP connector the person creates in HubSpot.

## Registering Spade's GitHub app (the owner)

1. Sign in to GitHub as the account or organisation that should own the app. Go to Settings,
   Developer settings, OAuth Apps, New OAuth App
   ([creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)).
2. Fill in:
   - Application name: `Spade`
   - Homepage URL: `https://acehq.dev`
   - Authorization callback URL: `http://127.0.0.1/v1/connectors/callback/github` (GitHub requires
     one; the device flow doesn't use it)
   - Check **Enable Device Flow**.
3. Register the application. Don't generate a client secret: Spade never uses one, and the
   repository refuses one.
4. Optionally upload Spade's logo (`apps/marketing/public/icon-192.png`), which GitHub shows on the
   page where people enter the code.
5. Copy the **Client ID** into `spade/config/connector-apps.json`, as the
   `client_id` of the entry whose `connector` is `github`. Commit it; it is public by design.
6. If the owning account is an organisation that restricts OAuth apps, approve Spade under the
   organisation's third-party access settings, or people in it will be asked to request access.

From then on GitHub's catalogue entry leads with Sign in, and signing in shows a code with Copy
code and Open. The person's own token and own client ID keep working as before.

## Asana, Box, Canva, HubSpot

Each requires a client secret, and a secret shipped in Spade would be public. Since ADR 0140 they
sign in through [Spade Cloud](cloud.md), which holds Spade's secrets for them; the owner
registers those apps with redirect `https://cloud.acehq.dev/v1/oauth/callback` (steps in
cloud.md). "Use your own client ID" stays: the person registers an app with the maker and types
its client ID and secret into Spade, which keeps the secret in the keychain (ADR 0131). Revisit this page if a maker starts
advertising `none` as a token endpoint auth method, a device authorization endpoint, or client ID
metadata documents.
