# Spade's own connector apps

On 2026-11-19, the catalogue reached 98 apps. [The catalogue](#the-catalogue-on-2026-11-19) lists
which apps can connect and how. The [owner checklist](#owner-checklist) covers registrations
and approvals ([ADR 0193](../../docs/adr/0193-spade-catalogue-says-what-connects.md)).

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
sign in through the broker in [ace cloud](cloud.md) (ADR 0141), which holds Spade's secrets for
them; the owner registers each app with redirect `https://cloud.acehq.dev/v1/oauth/callback/<app>` (steps in
cloud.md). "Use your own client ID" stays: the person registers an app with the maker and types
its client ID and secret into Spade, which keeps the secret in the keychain (ADR 0131). Revisit this page if a maker starts
advertising `none` as a token endpoint auth method, a device authorization endpoint, or client ID
metadata documents.

## The catalogue on 2026-11-19

Every entry in `spade/config/connectors.json` is the maker's own remote MCP server. Each was
checked on 2026-11-19 two ways: the maker's own page (`source`) names the address, and an
unauthenticated `initialize` to the address answered with the server's sign-in metadata
(protected-resource metadata, then the authorization server's: dynamic registration, client ID
metadata documents, `iss` in answers, token endpoint authentication). No one signed in to each
app; the first real sign-in remains the last check.

What Spade shows ([ADR 0193](../../docs/adr/0193-spade-catalogue-says-what-connects.md)):

- **Sign in (72)** includes Airtable, Amplitude, Apollo.io, Atlassian, Attio, Axiom, Basecamp,
  Buildkite, Cal.com, Calendly, Clerk, ClickUp, Close, Cloudflare, Cloudinary, Coda, Contentful,
  Datadog, DigitalOcean, Dropbox, Egnyte, Fireflies, Framer, Gamma, GitLab, Grafana Cloud, Granola,
  Guru, Help Scout, Heroku, Hex, Honeycomb, incident.io, Intercom, Jam, Jotform, Klaviyo,
  LaunchDarkly, Linear, Lucid, Make, Meltwater, Mercury, Miro, Mixpanel, monday.com, MongoDB Atlas,
  Neon, Netlify, Notion, Otter.ai, PagerDuty, PayPal, PlanetScale, PostHog, Postman, Prisma, Railway,
  Readwise, Resend, Rootly, Sanity, Sentry, Shortcut, S&P Global, Square, Stripe, Supabase, Tally,
  Todoist, Webflow and Wix. Each offers dynamic registration or supports Spade's client ID
  metadata document with `iss` in its answers (Honeycomb, MongoDB Atlas, PagerDuty).
- **Needs a key (6)** includes GitHub (until Spade's GitHub app is registered), Hugging Face,
  Render, Semgrep, Smartsheet and Zapier. Semgrep accepts a bearer token. Its OAuth discovery
  redirects, and Spade requires the metadata directly at the challenged URL.
- **Coming soon (20)** includes apps that connect through Spade Cloud once the owner registers Spade and sets
  the Worker's secrets: Asana, Box, Canva, Front, Gmail, Google Calendar, Google Chat, Google Docs,
  Google Drive, Google Sheets, Google Slides, HubSpot, Slack and Zoom. Figma, Pipedrive, Ramp
  and Vercel wait for maker approval. Typeform advertises dynamic registration and a client ID
  metadata document, but omits `iss` support and refused the authorization request after
  registration. Its [connector guide](https://developer.typeform.com/developers/mcp/build-a-connector/)
  says dynamic registration is allowlisted. Docusign requires a caller-supplied integration key,
  secret and registered redirect URI. People can also bring their own client ID for the cloud apps.

A cloud app turns to Sign in by itself once ace cloud lists it at `GET /v1/oauth/apps` (both of
its Worker secrets set); no Spade release is needed. An approval app needs its `waits_for` line
removed from `connectors.json`, then a release.

### Apps with no official remote MCP server to list (2026-11-19)

| App                                         | What exists                                                                                                                                                                                                                          | What it would take                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Microsoft 365 (Outlook, Teams, OneDrive)    | Agent 365 / Work IQ MCP servers: preview (Frontier), per tenant, Copilot licence, admin enables                                                                                                                                      | A multi-tenant Entra app with admin consent per organisation; Microsoft opening them beyond the preview. People in a tenant can add by URL |
| Discord                                     | `mcp.discord.com` answers with read-only scopes, but Discord publishes no page for it                                                                                                                                                | A Discord page to cite; then a Discord app (public client, PKCE) as one of Spade's own apps                                                |
| Shopify                                     | A local developer server and per-store storefront servers; no hosted admin server                                                                                                                                                    | Shopify shipping a hosted admin server                                                                                                     |
| Zendesk                                     | A server per account, its address in Admin Center                                                                                                                                                                                    | Nothing in the catalogue: add it by address                                                                                                |
| Salesforce                                  | Hosted servers per org, each needing an External Client App in that org                                                                                                                                                              | Add by address with the org's own client ID                                                                                                |
| Twilio, Mailchimp                           | Documentation search only (`mcp.twilio.com/docs`, `mailchimp.com/developer/_mcp/server`)                                                                                                                                             | Account servers (Twilio says planned)                                                                                                      |
| Squarespace                                 | Commerce tools only for two named clients; others get domain search                                                                                                                                                                  | Squarespace opening commerce tools to other clients                                                                                        |
| Plaid                                       | A dashboard server for Plaid's developers, client-credentials only                                                                                                                                                                   | Not a person's account                                                                                                                     |
| Spotify, Brex, Obsidian, WhatsApp, Telegram | No official remote MCP server found                                                                                                                                                                                                  | The maker shipping one                                                                                                                     |
| Stack Overflow                              | [Stack Exchange's setup guide](https://api.stackexchange.com/docs/mcp-server) names `mcp.stackoverflow.com`. An unauthenticated `initialize` returned a bare `401 Bearer`, and both protected-resource metadata URLs returned `404`. | A protected-resource metadata document Spade can discover                                                                                  |

### Marks

`packages/ui-core/src/app-art/` (generated by `node scripts/app-icons.ts` from the table in that
script): Simple Icons (CC0) for 65 apps and first-party marks for 9 (Hex, incident.io, Jam,
Mercury, Rootly, Semgrep, Slack, Smartsheet and Tally), each with its source and licence in
`LICENCES.md`.
These 24 show a monogram until their marks are added from each maker's brand kit: Amplitude,
Apollo.io, Attio, Axiom, Canva, Close, Docusign, Fireflies, Front, Gamma, Granola, Guru, Heroku,
Honeycomb, Jotform, Klaviyo, LaunchDarkly, Meltwater, monday.com, Otter.ai,
Pipedrive, Ramp, Readwise and S&P Global. To add one, save the maker's SVG in
`scripts/brand-marks/apps/`, point its entry at it, and run the script.

## Owner checklist

### 1. Deploy ace cloud with the apps list

From `apps/cloud`: `wrangler deploy --env production` (see [cloud.md](cloud.md)). Check with
`curl https://cloud.acehq.dev/v1/oauth/apps`: it answers `{"apps": [...]}` with every app whose two
secrets are set. Until this ships, Spade shows every cloud app as Coming soon.

### 2. Register Spade with each maker and set the Worker secrets

Every app's redirect URL is `https://cloud.acehq.dev/v1/oauth/callback/<id>`. Secrets go in with
`bunx wrangler secret put <NAME> --env production` from `apps/cloud`, with
`XDG_CONFIG_HOME=~/.ace-cloudflare`. The scopes are the ones `apps/cloud/src/broker/apps.ts` asks
for; register at least those.

| App(s)                                                                                                                                                                 | Where to register                                                                                                                                                                                                                                                                                                                                                                                                                                              | Redirect URL(s)                                                                                                                                                                                    | Scopes                                                                                                                                                                                                                                                                                                                                                                  | Secrets                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Asana (`asana`)                                                                                                                                                        | An MCP app in Asana's developer console ([Asana MCP](https://developers.asana.com/docs/integrating-with-asanas-mcp-server))                                                                                                                                                                                                                                                                                                                                    | `…/callback/asana`                                                                                                                                                                                 | `default`                                                                                                                                                                                                                                                                                                                                                               | `SPADE_CLOUD_ASANA_CLIENT_ID`, `SPADE_CLOUD_ASANA_CLIENT_SECRET`                            |
| Box (`box`)                                                                                                                                                            | An MCP client in Box's Admin Console ([Box remote MCP](https://developer.box.com/guides/box-mcp/remote/)); Box may limit it to your enterprise                                                                                                                                                                                                                                                                                                                 | `…/callback/box`                                                                                                                                                                                   | Box's own                                                                                                                                                                                                                                                                                                                                                               | `SPADE_CLOUD_BOX_CLIENT_ID`, `SPADE_CLOUD_BOX_CLIENT_SECRET`                                |
| Canva (`canva`)                                                                                                                                                        | An integration in Canva's Developer Portal with Canva MCP on ([Canva MCP access](https://www.canva.dev/docs/apps/mcp/access/)); public integrations are reviewed                                                                                                                                                                                                                                                                                               | `…/callback/canva`                                                                                                                                                                                 | The 16 in `apps.ts` (designs, folders, brand templates, comments, assets, brand kits, help)                                                                                                                                                                                                                                                                             | `SPADE_CLOUD_CANVA_CLIENT_ID`, `SPADE_CLOUD_CANVA_CLIENT_SECRET`                            |
| HubSpot (`hubspot`)                                                                                                                                                    | Development, then MCP Connectors ([HubSpot remote MCP](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server))                                                                                                                                                                                                                                                                                   | `…/callback/hubspot`                                                                                                                                                                               | HubSpot's own                                                                                                                                                                                                                                                                                                                                                           | `SPADE_CLOUD_HUBSPOT_CLIENT_ID`, `SPADE_CLOUD_HUBSPOT_CLIENT_SECRET`                        |
| Slack (`slack`)                                                                                                                                                        | A Slack app at api.slack.com/apps, then listed in the Slack Marketplace: "only directory-published apps or internal apps may use MCP" ([Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server/)). Until it's listed, it works only in the owner's own workspace                                                                                                                                                                                         | `…/callback/slack`                                                                                                                                                                                 | User scopes: `search:read.public`, `search:read.private`, `search:read.mpim`, `search:read.im`, `search:read.files`, `search:read.users`, `channels:history`, `groups:history`, `mpim:history`, `im:history`, `chat:write`, `canvases:read`, `canvases:write`, `users:read`, `users:read.email`, `files:read`, `files:write`                                            | `SPADE_CLOUD_SLACK_CLIENT_ID`, `SPADE_CLOUD_SLACK_CLIENT_SECRET`                            |
| Gmail, Google Calendar, Chat, Docs, Drive, Sheets, Slides (`gmail`, `google-calendar`, `google-chat`, `google-docs`, `google-drive`, `google-sheets`, `google-slides`) | One Google Cloud project: turn on the Gmail, Calendar, Chat, Docs, Drive, Sheets and Slides APIs and their MCP APIs ([Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers)); an External OAuth consent screen in production; one OAuth client of type Web application. Google's OAuth verification is needed for the sensitive scopes, and for Gmail and Drive's restricted scopes also its yearly security assessment | All seven: `…/callback/gmail`, `…/callback/google-calendar`, `…/callback/google-chat`, `…/callback/google-docs`, `…/callback/google-drive`, `…/callback/google-sheets`, `…/callback/google-slides` | `gmail.readonly`, `gmail.compose`, `gmail.modify`; `calendar.calendarlist.readonly`, `calendar.events`, `calendar.events.freebusy`; `chat.spaces.readonly`, `chat.memberships.readonly`, `chat.messages.readonly`, `chat.messages.create`; `documents`; `drive.readonly`, `drive.file`; `spreadsheets`; `presentations` (each under `https://www.googleapis.com/auth/`) | `SPADE_CLOUD_GOOGLE_CLIENT_ID`, `SPADE_CLOUD_GOOGLE_CLIENT_SECRET` (one pair for all seven) |
| Zoom (`zoom`)                                                                                                                                                          | A General app (user-managed OAuth) at marketplace.zoom.us, published to the Zoom App Marketplace for people outside the owner's account ([Connect to Zoom MCP servers](https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/))                                                                                                                                                                                                              | `…/callback/zoom`                                                                                                                                                                                  | `meeting:read:search`, `meeting:write:meeting`, `meeting:update:meeting`, `meeting:delete:meeting`, `meeting:read:assets`, `cloud_recording:read:list_user_recordings`, `cloud_recording:read:content`                                                                                                                                                                  | `SPADE_CLOUD_ZOOM_CLIENT_ID`, `SPADE_CLOUD_ZOOM_CLIENT_SECRET`                              |
| Front (`front`)                                                                                                                                                        | An app with OAuth in Front's developer settings ([Front MCP server](https://dev.frontapp.com/docs/mcp-server)); Front may require publishing it for other companies                                                                                                                                                                                                                                                                                            | `…/callback/front`                                                                                                                                                                                 | `feature:mcp`                                                                                                                                                                                                                                                                                                                                                           | `SPADE_CLOUD_FRONT_CLIENT_ID`, `SPADE_CLOUD_FRONT_CLIENT_SECRET`                            |

To confirm on each first sign-in: the broker sends the MCP spec's `resource` parameter to every
maker; Google's and Slack's docs don't mention it. If one refuses it, its broker entry must leave it
out.

### 3. Spade's own GitHub app

Steps above, under [Registering Spade's GitHub app](#registering-spades-github-app-the-owner):
register the OAuth app with device flow on and commit its client ID to `connector-apps.json`.
GitHub then turns from "Needs a key" to Sign in in the next release.

### 4. Ask four makers to let Spade in

No secret and no Worker change; once a maker says yes, remove `"waits_for": "maker_approval"` from
the app's entry and release.

| App       | Ask                                                                                                                                                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Figma     | To list Spade in Figma's MCP catalog ([remote server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)): "only clients listed in the catalog can connect"                                                                   |
| Vercel    | The client review form linked from [Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp). Alternatively, once Vercel's metadata says `authorization_response_iss_parameter_supported`, Spade's client ID metadata document works without review |
| Pipedrive | On Pipedrive's developer community, to approve Spade's client ID metadata document `https://acehq.dev/oauth/spade.json` and its redirect `http://127.0.0.1/v1/connectors/callback` (any port)                                                              |
| Ramp      | To allowlist the same client and redirect: "custom clients and gateways must have their exact redirect URI allowlisted" ([Ramp MCP](https://support.ramp.com/ramp-mcp/))                                                                                   |
