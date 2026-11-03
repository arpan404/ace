# 0100: WorkOS accounts on the relay backend

Accepted by the owner, 2026-10-24. Amends the no-hosted-service boundary in
[ADR 0002](0002-local-cli-providers.md) and
[ADR 0070](0070-runtime-remote-access.md). Amended by
[ADR 0111](0111-account-machine-access.md): an account now opens every machine on it,
and the backend runs in the Cloudflare relay Worker with D1
([ADR 0110](0110-cloudflare-relay.md)) instead of the Node relay. Pending logins are
stored in D1 and survive restarts.

The relay service is also ace's account backend. WorkOS AuthKit handles the
person's ace login; the backend owns the WorkOS integration and persistent ace
sessions. Desktop, web and iOS offer sign-in while local use remains available
without an account. Hosting this identity service does not authorize hosting
agent execution or collecting coding-provider credentials.

An ace account identifies a person. A provider account identifies a coding
provider login on a particular machine. A paired-device grant authorizes a device
to access a daemon. These remain independent: signing in to ace does not grant
access to a machine, change its scopes, or replace Noise host pinning.

Clients create a short-lived login request, open its public URL in a browser and
claim the resulting session using a separate private ticket. The backend uses
WorkOS authorization-code login with PKCE, random state and a browser-bound
HttpOnly cookie. No third-party cookie is required.
Claim retries return the same session until the request expires. Cancellation
revokes an unclaimed session and cannot be undone by an in-flight callback.

Opening the login URL spends nothing: it shows a page with one button,
"Continue to sign in", that posts the login id back to the backend's own origin.
Only that post binds the browser and goes to WorkOS, so link previews and
preloaders that fetch the URL cannot use up a sign-in, and another site cannot
push a login id it holds into the person's browser (the post must carry the
backend's own `Origin`). A sign-in may name a return address when it starts:
exactly `ace://account/signed-in` for the desktop and iOS apps, or
`/account/signed-in` on an allowed web origin. Anything else is refused. When the
callback ends, the browser goes there with only `?status=signed-in`, `cancelled`,
`failed` or `expired` appended: never a token, code or login id. The address
returns the person to the app; it never carries the session, which the app still
claims with its private ticket. Without a return address the backend shows its
own page. A callback for a sign-in that is unknown, expired or already used says
so; "could not be verified" is kept for a different browser.

The backend stores only hashes of ace session tokens. WorkOS refresh tokens are
encrypted with AES-256-GCM and bound to the hashed session identity. Each session
read refreshes with WorkOS; concurrent reads share one refresh, transient failures
are retryable and an invalid grant revokes the ace session. Sessions expire after
seven days and survive relay restarts. In-progress logins expire after ten minutes
and must restart after a backend restart. Sign-out revokes this ace session; it
does not sign the person out of every WorkOS browser session.

Desktop uses Electron secure storage and refuses the Linux plaintext fallback.
iOS uses a separate Keychain service. Web keeps the session in sessionStorage,
scoped to the backend origin, so closing the window ends local persistence.
Signing out requires reaching the backend to revoke the session.

The account API has an explicit origin allowlist, bounded pending logins, request
rate limits, generic errors and no-store responses. Existing anonymous relay
registration and device-authorized encrypted channels retain their current
contracts. Account-based host ownership and relay admission are separate work.

See [deployment and API](../relay/accounts.md) and
[WorkOS's authorization-code and PKCE documentation](https://workos.com/docs/reference/authkit/authentication/get-authorization-url).
