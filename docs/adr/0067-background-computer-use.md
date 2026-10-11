# 0067: Background computer use

Date: 2026-10-05. Status: accepted, live compatibility verification pending.

## Context

A person must be able to keep working while agents operate approved applications. ADR 0011's single target competes with Simulator sessions and its focus clicks can disturb that person. The public [OpenAI workspace controls](https://help.openai.com/en/articles/20001510-manage-browser-and-computer-use-in-your-enterprise-workspace), [release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) and the supplied `/tmp/codex-ref/cua/CAPABILITIES.md` describe application identities, scoped grants, background launch and accessibility actions. They are interface references only. No third-party bundles or implementation code were read.

## Decision

One retained macOS helper owns at most eight sessions. Each session has its own capture, accessibility refs, pixel leases, action queue and controller. App identity is an exact bundle id resolved to a live process by macOS. An application has one session lease, including across different windows, because keyboard focus and application state are shared. Competing acquisition returns `target_busy` with the holding session and controller. Display captures remain view-only. Simulator is an ordinary window target.

Every session starts in `background` mode. Use AXPress, advertised named actions, AXValue, AXSelectedText and AXSelectedTextRange before synthesized events. Coordinate clicks and scrolls also try advertised actions by process-scoped AX hit testing within the verified target window. AX scroll actions move by a page; process-posted scrolling retains delta input. AXRaise and app activation require foreground approval. Public [CGEvent.postToPid](<https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:)>) targets keyboard and window-relative pointer events. Background actions never post to the HID tap, activate an app or warp the cursor. A guard snapshots the frontmost process, its focused AX window and element, and the cursor before an action, checks after settling and reports `focus_changed` while attempting restoration. Restoration is an exception following an already observed violation, never an input fallback. A person moving focus during that bounded interval can also trip the guard. Recent HID input suppresses restoration so the guard does not undo the person's own movement; restoration is best effort.

Posted events have no delivery acknowledgement. When synthesized input produces no observable AX change, return `foreground_required`; this conservative result can also mean an action was a no-op. Never repeat it through foreground input automatically. Apps with incomplete accessibility need the owner's live check. Clipboard paste snapshots every pasteboard representation, posts paste to the approved process, waits at most 500 ms and restores the saved representations only if no other writer has changed the pasteboard. Interfering clipboard changes are reported instead of overwritten.

Capture uses ScreenCaptureKit's [desktop-independent window filter](<https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:)>). Occlusion does not require bringing a window forward. App sessions select an application window rather than capturing display pixels. Minimized and geometrically off-display windows return `window_minimized` and `window_offscreen`; another Space alone is not offscreen. Background launch uses NSWorkspace.openApplication with [activates=false](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/activates) and hides newly launched apps where supported.

Observations wait inside the helper for AX notifications and a bounded quiet interval, invalidate the tree cache, then return a compact fresh snapshot. There is no idle polling timer. Background operation while locked is permitted only as far as public AX and ScreenCaptureKit continue working; failed capture or missing target returns an error. No lock-screen bypass or locked-Mac parity claim is made without the owner's live check.

## Approval and safety model

SQLite stores screen enablement and exact app grants. Grants have `turn`, `thread` or `always` scope. Turn grants bind to the engine's current turn identity and expire on a new turn or daemon restart. Thread and always grants survive restart; controller leases and foreground/secure-input permission never do. Revocation invalidates queued work and stops affected sessions before acknowledging. App launches reserve their lifetime before helper startup; revocation, disablement and shutdown invalidate and drain these reservations. Launch dispatch rechecks grants, enablement and caller cancellation after startup and after acquiring the shared execution slot. Disabled screen access cannot be enabled by an agent request.

`screen_request_app` opens a blocking host interaction through the engine's existing approval machinery with Allow once, Allow for this thread, Always and Deny. Sensitive applications always ask, even with a saved grant, and cannot be auto-reviewed: password managers, System Settings, Keychain Access, Terminal, iTerm and ace. Sensitive application matching is conservative and cannot enumerate every third-party password manager. Unknown apps still require exact human approval. Foreground escalation is per session, opens a separate blocking host approval and enables activation and HID input only after resolution. Secure text refuses all agent text/key/paste paths until the human explicitly enables secure input for that session. Missing or failed role/subrole reads have an explicit unknown classification and refuse typing even with secure-input consent. A documented unsupported/no-value subrole is a known absence. Text input rejects navigation controls; only AX selection replacement accepts literal newlines. Keyboard fallback revalidates destination identity and security between characters and checks consent at every event. Background AX focus mutations within the frontmost app are refused. Snapshots and audit records never contain secure or unclassified text values.

The kill switch persists disabled screen access, invalidates starts in progress and blocks agent reacquisition until a person enables screen access again. Human takeover replaces only the selected controller and invalidates its queued actions. A bounded host queue orders mutation workflows across sessions. All macOS helper commands, including observations, also share a bounded 32-command dispatch queue. Each mutation revalidates its controller epoch, owner, binding and grant immediately before writing native stdin, after any prior read or action has acknowledged. An action already dispatched can finish; other sessions remain independently controlled. Native stdin never receives another agent action buffered behind that action with stale foreground or secure-input authority. `stop.all` first releases every agent lease and then stops all sessions. State broadcasts list session mode, target, controller, holder and capture indicator so the UI can show every controlled app even without pixel subscribers. Compact step items record session, action kind, mode and outcome, never typed text or key contents. A helper failure fails every session; stopping a healthy session does not terminate other sessions.

## Platform scope and follow-up

Windows already has UIA Invoke/Value/Scroll patterns and Linux has AT-SPI semantic actions. Their current capture/input helpers retain the single-target contract. Background mode refuses agent input there until background delivery and multi-session routing are implemented and exercised. Follow-up: Windows per-session UIA roots and capture, verified HWND PostMessage delivery subject to UIPI, Linux per-session AT-SPI targets and compositor capture. Never use SendInput or XTest as an implicit background fallback. Platform foreground escalation uses the same approval contract.

## Compatibility and validation

TextEdit/Calculator AX controls are expected to work without activation but require a disposable-window live check. Simulator pointer and AX hardware buttons use process/window routing; its keyboard events may be ignored in the background. Electron apps, games and canvas-only applications may ignore process-posted events or expose no useful AX tree, and then return `foreground_required`. These are expectations and known API limitations, not a verified app matrix.

Behavior tests use a real fake-helper process and temporary SQLite, injected ids and clocks. Native unit tests inject posting, launch, clipboard and focus boundaries and assert destination/restoration effects without operating desktop apps. App-focused window selection resolves AX bounds once and performs one linear scan of at most 128 candidates. Native and process regression tests are written and compiled, but not executed under the owner's current rule. Only fast static checks and Swift compilation run during this revision; tests, mutation runs and daemon benchmarks need run at merge. Historical benchmark results are recorded in the PR and do not certify the revised head. Native app interaction and locked-Mac capture remain owner checks; automated validation must not touch user documents or provider CLIs.

## Amendment: exact identity and background delivery (2026-10-07)

This amendment supersedes the frame-only matching, focus restoration, off-display
capture rejection, tree-diff delivery verdict and single native command queue above.

One `WindowResolver` owns AX-window/CGWindowID correspondence. It loads the
read-only private `_AXUIElementGetWindow` symbol with `dlsym`, checks availability,
AX status, PID and the live CG owner, and caches verified refs within a session.
This identity query is widely used by macOS window managers, including
[AeroSpace](https://github.com/nikitabobko/AeroSpace/blob/main/README.md), because public AX
attributes do not uniquely distinguish maximized windows. The owner may veto this
private API choice. That would retain the conservative fallback and reduce support
for identical windows; it must never restore the old focused-window substitution.
The fallback matches title and current frame against CG candidates in stacking
order. Stacking order orders diagnostics, rather than guessing which identical AX
window owns an ID. Remaining ambiguity returns `window_ambiguous` and bounded
candidates. Focused/main AX windows are additional candidates, including on other
Spaces, and must prove their ID just like every other candidate.

Input, semantic refs, foreground preparation and capture validation share this
resolver. Foreground preparation resolves the target and rejects unusable geometry
before activation. Every foreground keyboard post checks the actual keyboard app
and focused window at the posting boundary. Only foreground pointer input requires
intersection with a physical display. Desktop-independent capture and background
input accept off-display windows. Minimized capture remains an explicit error.

The disposable AppKit fixture exposed a limit beyond the supplied diagnosis:
window-tagged process events arrive with the requested window number, but AppKit's
text responder can still edit the application's other key window. Background field
editing therefore uses AX selection/value operations first, including printable
keys, select-all and horizontal navigation. Raw process keyboard fallback validates
the application's actual destination field's window before every event. It does
not require the target app to be frontmost. It refuses a different responder with
`no_key_window`, rather than silently editing another window. Vertical navigation,
function keys and arbitrary responder-chain shortcuts still depend on application
support. `menu.press` and `open.url` avoid keyboard responder-chain shortcuts.

`open.url` uses NSWorkspace's
[explicit application URL operation](<https://developer.apple.com/documentation/appkit/nsworkspace/open(_:withApplicationAt:configuration:completionHandler:)>)
with `activates=false`, no prompts and no Recent Items entry. It reports the app's
acknowledgement, not proof of page navigation. `menu.press` walks an exact menu-bar
title path, bounded to eight components and 64 children per component, and presses
only an enabled advertised AXPress item. Menu actions apply to the approved app's
own menu target; ace does not manufacture a key window or guarantee an application's
nil-target menu action can run in the background.

The focus guard observes only target activation/target-window raising, ignores
cursor motion and human-attributable changes, and returns warnings on success.
It never restores desktop focus, AX focus, cursor or Space. Acknowledged typing is
never converted to failure by this guard. Action errors take precedence over focus
observations. Synthesized delivery checks the destination's character count and
selection, rather than comparing truncated trees. Uncertain delivery reports
`delivery_unconfirmed` with a do-not-retry hint. Errors preserve dispatch phase:
`rejected-before-dispatch`, `dispatched` or `partial`. Unsupported key/modifier names
have separate authored codes. The public MCP boundary retains these codes and
phases while continuing to replace arbitrary native messages with fixed copy.

Native commands have bounded per-target lanes. Awaiting an action or measurement
in one app does not stall another app's lane. Foreground HID, human-device input
and foreground clipboard transactions share a global lane. Background paste uses
AX selection replacement or a bounded AXValue edit and never opens the clipboard.
Window and field refs use live owner/destination checks and notification
invalidation; value-only notifications retain identity refs. Keyboard input
reuses the captured SCWindow rather than enumerating ScreenCaptureKit per key.
AX traversal retains node/depth/byte/time caps and 50 ms messaging timeouts.
Character-event fallback is capped at 256 characters and a one-second injected
clock budget, stopping between characters and reporting partial dispatch. The
AppKit/AX synchronous portions still run on the main actor, so a slow individual AX
call can briefly block other lanes. Daemon host workflow scheduling remains the
separate follow-up described by the supplied diagnosis; this amendment does not
claim full parallel end-to-end tool execution yet.

The helper protocol adds `open.url`, `menu.press`, warning/phase metadata and
bounded ambiguity candidates. Windows/Linux decode the additive requests and
explicitly reject the two background app operations before dispatch. They retain
their existing foreground-only scope and gain portable key aliases/error codes.
This native work exposes helper operations; agent-tool registration/window selection
policy belongs to the screen-package follow-up. No new agent approval route is added.

Validation uses only the disposable two-window fixture under
`native/screen-helper/Tests/Fixture`, Swift unit tests and helper process tests.
It covers identical frames, separate off-display windows, capture, targeted AX
writes, background typing/paste, menu/URL delivery, raw event destinations, rejected
foreground pointer input and independent command lanes. It does not drive Safari,
other owner apps, real documents or provider CLIs. Release signing/notarization,
locked-Mac behavior and actual Safari compatibility remain unverified.

## Amendment: audit recovery and consent boundaries, 2026-10-10

A failed or stopped session releases its application after capture cleanup. An
approved caller can replace an ownerless live session. Capture startup still
reserves the application until it finishes or is cancelled. A request timeout
rejects that request; a failed stop probes helper liveness on the inspection lane
before considering process termination. Native stream failure reports a
`session.failed` event with `target_gone` for its own session, leaving other
captures running.

Foreground consent binds to the current root turn and returns to background at
turn end or change. Background actions refuse tracking menus and popup presses.
After an observed target activation or window-focus change, the focus guard
attempts to restore the former app or AX focus, unless HID input occurred during
the action. This supersedes the 2026-10-07 no-restoration choice. Restoration is
best effort and does not move the cursor. Newly launched background apps remain
visible for capture, with activation disabled.

Permission inspections have their own helper lane. Swift checks permissions at
command boundaries and emits changed facts, retaining independent native checks
at input dispatch. Frame authorization caches the policy/grant revision; grant
changes and turn events synchronously invalidate it before revalidation. Tree
and find inspections use a 200 ms AX messaging budget, restoring the 50 ms global
input budget after the synchronous read. Node/request bounds remain unchanged.

Provider-native permission modes remain independent of ace computer consent,
as established in ADR 0069 on provider-native permission modes. The current
engine's `permissionAuthority` is always `ask` for these tools; there is no ace
read-only authority to enforce through screen grants.
