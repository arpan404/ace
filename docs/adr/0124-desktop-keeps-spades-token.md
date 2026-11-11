# 0124: The desktop keeps Spade's token in its main process

Status: accepted. Date: 2026-11-11. Decided by: the owner, accepting the build of PR #1796.
Amends [ADR 0123](0123-spade-runs-as-its-own-service.md), decision 6; the rest of 0123 stands.

## Context

ADR 0123 decision 6 had the desktop main process hand the page Spade's address and token, so the
renderer would call Spade's HTTP API itself. Building it showed two problems: the page is served
from `app://ace` under a content policy that allows only the daemon, and Spade's local API sends
no CORS headers. Opening either would widen what the page can reach, and the page would hold a
secret that controls Spade.

## Options considered

- **Give the renderer the token and add CORS on Spade (decision 6 as written).** More code paths
  and a secret in the page.
- **Chosen: the main process forwards.** The page asks through the preload bridge; the main
  process holds the token and talks to Spade.

## Decision

1. **The token never reaches the page.** `window.ace.spade` forwards HTTP requests, live streams,
   uploads and image reads to Spade from the main process, which alone reads the token file.
   `endpoint()` returns the address, version, API version and machine id, never the token.
2. **Only for this machine, only to the real Spade.** The direct path is used when the window's
   daemon is this computer's (its `host.identity` matches `<ACE_HOME>/host-id`), and only after
   Spade answers `/health?nonce=` with the right proof (see `spade/docs/ace-integration.md`);
   otherwise the page uses the daemon's `spade.*` family.

## Consequences

- No CORS on Spade and no change to the page's content policy.
- Every direct request costs one IPC hop in the desktop, which is cheaper than the daemon path it
  replaces.

## Tests

The desktop bridge tests: the page receives no token; a wrong or missing proof sends nothing; a
window on another machine never uses the direct path.
