# Native window identity and background input validation

Validated on macOS arm64 on 2026-10-07, using only the disposable
`native/screen-helper/Tests/Fixture` AppKit app. No commands targeted owner apps,
provider CLIs, live ace data, or real documents.

## Fixture and regression

The fixture has two windows with identical initial frames and separate text
responders. Its default frames are far outside every connected display. It emits
window IDs, actual received key events, text values, activation state, menu signals
and URL acknowledgements. IPC events synchronize tests; latency is never a gate.

The saved pre-change helper fails the new native process regression at session
start with `window_offscreen`, before any input or activation. The final helper
passes. It reads the correct AX root, writes only the selected field, types and
pastes into both windows without activating, captures off-display pixels, presses
an explicit menu item and delivers an application URL. A foreground pointer action
outside every display is rejected before dispatch and before activation.

An additional live finding informed the implementation: AppKit received a key
event with the selected window number while its responder chain edited the other
key window. AX field editing avoids that chain. Raw event fallback must verify the
application's actual responder window; event tags alone cannot establish delivery.
The regression checks both a pre-dispatch responder rejection and a dispatched,
unconfirmed F-key whose actual event destination is the selected window.

## Reported latency

`node --experimental-strip-types packages/screen/bench/identity.ts` measures eight
sequential samples per operation/window through the public helper process API.
Capture is disabled, both windows have identical on-display frames, and the
fixture remains inactive. The table uses the upper median of eight samples;
`ui.tree` is predominantly cached. Input payloads are one printable `l` key and
three text characters, `abc`.

| Window / helper      | key.press (ms) | text.type (ms) | ui.tree (ms) |
| -------------------- | -------------: | -------------: | -----------: |
| Identity 0, baseline |         300.66 |         236.06 |       165.61 |
| Identity 1, baseline |         242.45 |         233.58 |       176.95 |
| Identity 0, final    |          17.78 |          18.51 |         1.96 |
| Identity 1, final    |          17.28 |          15.70 |         2.56 |

Baseline requests included identity errors and incorrect-root selection; these
numbers describe failure latency, not successful throughput. The final run had
zero errors and fixture snapshots confirmed all eight keys and all eight text
writes reached only their selected window. Both snapshots reported `active=false`.
These measurements are illustrative, not a controlled speedup claim. Host load
was extreme (observed load averages 191–337), and other orchestrator work was
running. An earlier loaded run rejected some first-window destination lookups at
the traversal cap. Revalidating cached field refs and avoiding identity-cache
invalidation for value-only notifications removed those failures in the final run.
A transient AX timeout can still reject work safely under load. One native
regression invocation during concurrent repository checks failed to resolve an AX
window; a subsequent isolated invocation passed on the same sources. This is a
known load sensitivity, not evidence of a wrong-window dispatch.

## Checks run

- Swift `KeyInputTests`: punctuation, F-keys, aliases and modifiers produce window-tagged events; unsupported names reject before posting; ambiguous fallback retains both candidates.
- Swift `TextInputTests`: security classification and destination changes prevent unsafe writes; slow fallback stops at a character boundary with partial dispatch.
- Swift `InputDeliveryTests`: permission/foreground-only rules, actual keyboard destination changes and inactive app launch configuration.
- Swift `BackgroundSafetyTests`: target activation/raising warns, human activity and cursor changes do not fail success, and no focus restoration occurs; clipboard races preserve human content.
- Swift `CommandSchedulerTests`: another app proceeds while one target waits; same-target work stays ordered; coordinated foreground/clipboard work does not overlap.
- `identity.native.process.test.ts`: identical/off-display AX, input, capture, menu and URL destinations; no fixture activation; rejected foreground pointer input.
- `helper-routing.process.test.ts`: independent session dispatch and authority revalidation before a queued mutation reaches a real fake-helper process.
- `agent-errors.test.ts`: authored reasons and phases survive MCP sanitization; ambiguity exposes candidate IDs while arbitrary helper text is stripped.
- Existing process files `helper`, `background`, `review-safety` and `v2` pass individually.
- Native optimized build and Windows/Linux host-portable `cargo check` pass.
- `fmt`, `lint`, `typecheck`, `docs:protocol`, `check:size`, `check:ui` and `check:deps` pass. Dependency-cruiser retains its existing TypeScript 7 compatibility warning; UI values retain existing advisories.

No full repository suite was run, as instructed. Windows/Linux platform-specific
runtime paths were not executed on macOS. Safari, real Space switching, locked-Mac
capture and release signing/notarization remain unverified. The private read-only
AX identity query can be vetoed by the owner; without it identical windows remain
conservatively ambiguous. Helper operations are available in the shared protocol;
agent-tool registration and the host's global workflow queue remain follow-ups.
