# 0069: Provider-independent ace tool results

Date: 2026-10-07. Status: accepted.

## Context

Provider echoes disagree about MCP names, errors and image results. Claude drops
result content. Friendly tool rows need ace's actual result without raw blob exports.

## Decision

Add optional `ToolCall.result`. It contains `isError`, bounded text and image
attachment references, optional bounded `structuredContent`, and `durationMs`.
Screen results carry target bundle/window/name, post-action mode and screenshot
scale/size when available. No existing field or event changes meaning.

Capture results through the daemon MCP registry observer, including errors,
cancellation, timeout and pre-dispatch failure. Store indexed evidence in SQLite
separately from adapter snapshots. Correlate by thread, agent, canonical name,
arguments and lease/call boundaries. Identical concurrent calls remain unlinked
when identity is ambiguous. Provider work retains its status until the provider
finishes; the observer does not end a run or tool early.

Store images with the existing chunked thread-attachment API. Evidence retains
attachments across reconnects, later provider updates and daemon restart. Thread
deletion permits collection. Results contain at most 16 blocks, 32 KiB of text and
32 KiB of structured JSON; image uploads total at most 8 MiB per result. Registry
call slots cover capture as well as execution. Attachment failures leave a fixed
unavailable-image message and preserve the action's actual outcome.

Normalise ace namespaces once in core, before raw data is capped. Conservatively
redact all stored ace text-input arguments, approval previews and raw envelopes, and omit input
result snapshots and images. Providers can echo input before the helper identifies
a secure field, so conditional redaction after dispatch would be too late. Text
still reaches the authorised helper. Fixed public errors retain only reviewed
literal helper details, at most 256 characters, and permission-specific hints.

The result observer emits one `screen.step` notice per MCP invocation, linked to
the canonical tool ID when known. This includes reads and approval tools and
failures before dispatch. The manager's agent-only audit sink no longer emits a
duplicate notice. Native helper and manager execution internals remain unchanged.

Desktop exposes `shell.appIdentity(bundleId)` through the parsed shell bridge.
macOS resolves installed apps through Launch Services and the system file display
name, then Electron supplies the file icon. Cache at most 256 identities, run at
most eight lookups, and cap PNG URLs at 128 KiB. Other platforms and browser-only
clients return no identity and use their existing name fallback. The target name
in daemon evidence is a bundle-derived fallback; desktop clients can replace it
with the localised system name.

## Consequences

The UI can render results for every provider without decoding native envelopes.
Result capture preserves evidence rather than changing agent-tree completion.
Ambiguous calls never inherit another call's screenshots. Text-input rows sacrifice
stored text previews to avoid retaining secrets. Icons belong to the client machine;
remote clients may not have the daemon host's app installed.

Primary APIs: [Apple bundle-ID lookup](<https://developer.apple.com/documentation/appkit/nsworkspace/urlforapplication(withbundleidentifier:)>),
[Electron file icons](https://www.electronjs.org/docs/latest/api/app#appgetfileiconpath-options).
