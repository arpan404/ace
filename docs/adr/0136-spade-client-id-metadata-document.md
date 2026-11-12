# 0136: Spade signs in to connectors as a client ID metadata document hosted on acehq.dev

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: "fix all those", after
being asked to host Spade's client ID metadata document on acehq.dev). Amends
[ADR 0131](0131-spade-connectors.md), decision 2 (how Spade gets a client ID and where sign-ins
come back to).

## Context

ADR 0131 signs Spade in to each app's MCP server with dynamic client registration, or with a
client ID the person registers with the maker by hand. The MCP authorization spec (2026-07-28,
"Client Registration") now ranks OAuth Client ID Metadata Documents
(draft-ietf-oauth-client-id-metadata-document) ahead of dynamic registration, which it marks
deprecated. With a metadata document the client ID is an `https` address; the authorization
server fetches the JSON there and checks that its `client_id` is that same address and that the
sign-in's redirect is one it lists. Nothing is registered, and an app maker that allows such
clients needs no review of Spade first.

A metadata document must be served from a stable `https` address that ace controls. Spade runs on
the person's machine and has none of its own; acehq.dev, the marketing site, does.

The document can list only fixed redirect addresses. ADR 0131 gives every connector its own,
`/v1/connectors/callback/<connector>`, and connectors added by URL get ids nobody can list in
advance. Loopback redirects may carry any port (RFC 8252 section 7.3, RFC 9700 section 4.1.3), but
their path must match exactly.

## Options considered

- **Keep dynamic registration only.** Works where offered, but the spec deprecates it, and makers
  who only take reviewed or metadata-document clients stay closed.
- **List the catalogue's connectors in the document, one redirect each.** Breaks for every server
  added by URL, and changes the public document whenever the catalogue changes.
- **Chosen:** one document, one shared loopback redirect, and the `state` routes the answer to its
  sign-in. `iss` is then required, since the client ID and redirect are the same at every server.

## Decision

1. **The document.** `https://acehq.dev/oauth/spade.json`, served from
   `apps/marketing/public/oauth/spade.json` by Cloudflare Pages as `application/json`
   (`apps/marketing/public/_headers`):

   ```json
   {
     "client_id": "https://acehq.dev/oauth/spade.json",
     "client_name": "Spade",
     "client_uri": "https://acehq.dev",
     "logo_uri": "https://acehq.dev/icon-192.png",
     "redirect_uris": ["http://127.0.0.1/v1/connectors/callback"],
     "grant_types": ["authorization_code", "refresh_token"],
     "response_types": ["code"],
     "token_endpoint_auth_method": "none",
     "application_type": "native"
   }
   ```

   It holds no secrets: Spade is a public client using PKCE, so there is no client secret, no key
   and no token anywhere in it, as the draft (section 4.1) requires. Anyone may read it. Changing it
   changes what every authorization server accepts from every Spade, so it changes only with an
   ADR.

2. **When Spade uses it.** By the spec's order: a client ID the person gave (now, or earlier for
   the same issuer) first; then the document, when the authorization server's metadata has
   `client_id_metadata_document_supported: true` and either advertises
   `authorization_response_iss_parameter_supported: true` or offers no registration; then a client
   Spade registered before; then dynamic registration (now sending `application_type: native`, as
   the spec asks); else the person is asked for a client ID. A server that supports the document
   and registration but doesn't say it sends `iss` is registered with, because registration's
   per-connector redirect tells its answers apart without `iss`.

3. **The shared callback.** A sign-in as the document comes back to
   `http://127.0.0.1:<Spade's port>/v1/connectors/callback`. Its `state` names the sign-in; the
   answer must carry `iss` equal to that sign-in's issuer, whatever the server advertises (the
   draft, section 7, makes `iss` mandatory). An answer for a sign-in with its own per-connector
   address that arrives at the shared one, or the reverse, is refused. Spade uses the document only
   when it listens on 127.0.0.1, the one host the document lists. Sign-ins with registered or
   hand-made clients keep ADR 0131's per-connector addresses.

4. **One constant.** The address is `spade_connect::CLIENT_METADATA_URL`; `SPADE_CLIENT_METADATA_URL`
   replaces it in development, and tests pass their own.

## Consequences

- Linear, Notion, Sentry, Neon and Cloudflare (each advertises both the document and `iss`, read
  from their authorization-server metadata on 2026-11-12) sign Spade in without a registration.
  Their catalogue entries already said "Sign in"; nothing changes for the person.
- No app that needed a client ID gains one-click sign-in yet: Asana, Box, Canva, GitHub and
  HubSpot advertise no metadata-document support. Vercel's documentation accepts metadata-document
  clients without review, but its metadata advertises registration and not `iss`, so Spade would
  register there and be refused; Vercel stays out of the catalogue until it names itself. Figma
  advertises no document support. Atlassian supports the document but not `iss`, so it keeps
  registration.
- acehq.dev must serve the document before a Spade that uses it ships: a server that fetches it
  and finds nothing refuses the sign-in. A broken or moved document breaks sign-in for those
  servers until fixed.
- An existing connector whose server now takes the document signs in as the document the next
  time it reconnects. Refreshing a stored sign-in is unchanged.

## Tests

- A fake authorization server that advertises the document fetches it from a local stand-in for
  acehq.dev (the hosted file with only its `client_id` moved) and checks `client_id`, a public
  client and the loopback redirect; Spade signs in with the document's client ID, PKCE and the
  shared callback, with no registration, and its tools work.
- An answer to a document sign-in without `iss` is refused before any token request; answers at a
  callback address their sign-in didn't use are refused.
- A server that doesn't fetch documents, or fetches them but doesn't name itself while offering
  registration, gets a registered client and its per-connector address.
- The hosted file parses, its `client_id` is `CLIENT_METADATA_URL` and matches its path under
  `public/`, it holds no secret, and it allows exactly Spade's shared loopback callback on any port.
