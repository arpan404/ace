# 0070: Runtime remote access and browser pairing

Status: accepted by the remote-access task. Date: 2026-10-07.

## Decision

Global administrator settings writes to `remote.enabled`, `remote.transport` and
`remote.relayUrl` reconcile network resources before reporting success. They do
not change the local listener, host credential, agent sessions or stored paired
devices. A failed prerequisite leaves the previous listener running. A failed
replacement attempts to restore the previous configuration. Pending codes and
tickets and existing remote connections end when transport changes. External
settings edits use the same serialized, bounded reconciliation path.

An explicitly supplied `ACE_LISTEN` overrides direct listening. `ACE_RELAY_URL`
independently overrides the outbound relay. The status API exposes actual remote
access and these overrides so the UI cannot show an editable off switch while a
launch override keeps access open. Tailscale discovery failure never enables LAN.

The TLS listener serves only shipped web assets, streamed from a fixed renderer
root. `/pair` works before an authenticated client exists. Reading its fragment
removes it from browser history; the person confirms the device name before
redemption. Only the host chooses scopes. Codes last five minutes and redeem
once; device tokens and pairing codes are never logged. The client saves the
issued device ID alongside its token and exchanges that token for a fresh ticket
on every connection attempt, including worker and page fallbacks. Remembering
access is explicit; otherwise it lasts in session storage.

The existing access-origin allowlist also governs status, redemption and ticket
requests. The desktop renderer remains allowed. This permits the desktop and a
configured web client to complete pairing without opening cross-origin access
to arbitrary sites. No cookies or URL tokens authenticate requests. Browsers use
trusted HTTPS; native Node clients retain the existing public-key pinning boundary.

`host.displayName` and `host.icon` are global administrator settings. Machines and pickers use
the authenticated host identity instead of URL hostnames. Clearing the name
restores the macOS computer name, or a readable hostname on other systems. The
icon is a built-in shape with an optional colour, or an emoji. Settings > Remote
devices edits the identity on the chosen connected host; the client directory
caches it for offline labels. Thread metadata retains the stable host ID, and
shared machine labels resolve the current name and icon. The legacy OS hostname
is an identity alias for old local threads, never their display name. Device rows display stored scopes; Projects and Accounts
remain independent grants under Advanced access even with administrator access.

## Relay boundary

Runtime Relay selection owns the already implemented encrypted auxiliary
channels, using the user's self-hosted endpoint. Relay selection keeps the LAN
listener for pairing and conversations. A configured relay also runs alongside
LAN or Tailscale. The existing relay does
not implement main conversation or pairing channels. The UI describes this
boundary; adding those channels requires a separate transport contract.

Unavailable saved transports leave the local listener usable, expose an error
status and retry with bounded backoff. The live runtime relay is also the
delegation files relay; hosts without it are excluded from device discovery.

## Verification

Real HTTPS, SQLite and WebSocket tests cover runtime toggling, host continuity,
redemption, scope escalation rejection, single use, expiry, revocation of pending
links, launch overrides and Tailscale failure. A real encrypted relay test covers
start, disconnect, restart and persistence of paired-device access. UI tests cover
pairing confirmation, storage, connection, errors, remote settings, machine
renaming and independent advanced grants. Screenshots use the fake daemon only.
