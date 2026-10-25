# 0100: WorkOS accounts on the relay backend

Accepted by the owner, 2026-10-24. Amends the no-hosted-service boundary in
[ADR 0002](0002-local-cli-providers.md) and
[ADR 0070](0070-runtime-remote-access.md).

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
HttpOnly cookie. No client callback scheme or third-party cookie is required.
Claim retries return the same session until the request expires. Cancellation
revokes an unclaimed session and cannot be undone by an in-flight callback.

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
