# 0037: Windows screen helper and protocol v2

Date: 2026-10-02. Status: accepted, Windows runtime verification pending.

## Context

ADR 0011 owns screen sessions, approval and binary JPEG transport. The supplied competitor inventories describe desktop browser automation, screenshot-based computer use, takeover and recordings. They leave room for a daemon-owned accessibility interface that works without an Electron client and sends a small semantic tree before pixels. The inventories are feature references only. This implementation is written from our contract and Microsoft's API documentation.

The macOS helper speaks v1. Windows needs a portable contract, local pipes, DPI-aware input and an independent native implementation. A helper compiled on macOS cannot prove capture, input, UI Automation or ACL behaviour on Windows.

## Decision

Add a Rust executable in `native/screen-helper-windows`, using Microsoft's `windows` bindings and a static CRT. System Windows DLLs are the only dynamic dependencies. Install the signed executable once at a stable path under the ace data directory. The daemon keeps one Windows helper for its host lifetime, with at most one active capture target. It never spawns a process per screenshot, input or tree query.

Use Windows.Graphics.Capture on Windows 10 1903+ and Windows 11. Frame-arrived events wake capture; there is no polling capture timer. Direct3D11 scales before CPU readback. A tile hash suppresses duplicate pixels before JPEG encoding. JPEG uses the Rust `jpeg-encoder` crate: it is statically linked, works on the host for tests and benchmarks, avoids COM stream allocations and gives a bounded memory encoder. Independent JPEGs permit dropping pending frames without decoder recovery.

Use SendInput with per-monitor v2 DPI awareness. Coordinates in v2 are target-local logical points; map through the current physical target origin and DPI, then into the virtual desktop's absolute mouse range. Unicode text uses UTF-16 KEYEVENTF_UNICODE pairs. SendInput is foreground-only and subject to UIPI; refuse a different foreground window, a secure desktop or a stale target. Never elevate or bypass UAC.

Use IUIAutomation with an element-scoped CacheRequest and bounded control-view walks. Cache properties and supported patterns together, rather than requesting each property across processes. Runtime IDs identify elements for the target's lifetime, including capture pauses. References persist across reads until eviction or target replacement; stale refs fail. Invoke, Value, Scroll, ExpandCollapse and SelectionItem are tried before input fallback. Only unsupported patterns permit a bounds-centre input fallback, reported explicitly. Provider errors and read-only Value patterns do not silently become clicks or typing.

## Protocol and wire additions

Keep v1 schemas and consumers intact. Add schema-only v2 exports alongside them. Commands and replies use bounded newline JSON on stdin/stdout. `hello` returns version, platform, capture and input support, semantic actions, codecs and permission statuses. Legacy start, stop, permissions, targets and action commands remain supported. `ui.tree`, `ui.find`, `ui.act` and portable input commands are additive.

`--endpoint` accepts `pipe:\\.\pipe\ace-screen-<random>` on Windows. The helper creates the pipe before acknowledging hello; the daemon connects after negotiation. Windows owns the server so it can apply an explicit protected DACL granting only the current token's user SID access and reject remote pipe clients. Unix v1 continues using `--socket`; negotiated v2 uses `unix:/path`.

Frame packets retain the four-byte big-endian JSON header length and exact payload byte count. v2 adds seq, ts, scale and optional dirtyRects, alongside session and dimensions. The daemon normalizes aliases for existing viewers and recordings. Caps remain 4096 header bytes, 8 MiB JPEG bytes, 3840 by 2160 output pixels and 30 fps. Tree requests have hard node and depth caps, bounded strings and a truncation flag; replies are capped independently. Unknown replies remain available in bounded diagnostics.

Windows v2 start/watch commands and frame headers also carry an optional positive safe-integer `captureGeneration`. The daemon allocates increasing generations across the helper's lifetime, including target restarts and demand transitions. Retiring capture clears the pending output slot and rejects retired producers. A partial pipe write must finish its whole packet to preserve framing; cancelling it would corrupt the following packet. The receiver discards packets for another session, a retired generation or paused capture. Resume clears the cached screenshot and accepts only the new generation, while frame sequence numbers continue. Raw v1 clients retain their existing headers; a raw v2 client omitting the field gets generation 1.

The daemon registers all eight exact `screen_*` MCP names when configured with a screen manager. A lease needs the `screen` capability and a human-delegated session bound to both credential thread ID and agent ID. Arguments cannot supply a session or owner. The manager rechecks delegation after reads so takeover cannot expose a late result. Rich MCP results have a separate validated 12 MiB cap to fit base64 expansion of an 8 MiB JPEG; existing structured tools retain their 256 KiB cap. Screen tool descriptions direct agents to query the UI tree before taking screenshots.

## Security and performance

Human application approvals and controller ownership remain daemon policy. After merging remote access, the screen WebSocket bridge requires admin scope, including observation and approval changes. The local host token has admin authority; a paired read/operate device cannot observe screen state or grant itself computer control. Windows application identities are full executable paths obtained from the OS, not names supplied by an agent. Window capture checks that identity again. Whole-monitor capture is rejected unless the human explicitly approves the monitor identity: Windows cannot redact unapproved overlapping windows using WGC. Monitor input remains view-only. Secure desktop access maps to busy or target_gone, never a fabricated permission prompt.

Bound command lines, frame slots, tree references and input batches. Frame output retains one in-flight and one newest pending packet. Capture sessions close when no viewer or action needs them; the helper itself stays alive. Hash work is proportional to output pixels on a delivered frame, with no scan of prior frames. No frame files or temporary executables are created. Authenticode signing belongs to release packaging. macOS release packaging requires a stable `.app` bundle ID, Developer ID, hardened runtime and notarization; development builds should keep one signing identity rather than repeatedly changing it.

Stop first reports `stopping` with the current capture indicator, then waits for native cessation or process exit before turning the indicator off. Artifact publication follows cessation. Shutdown always closes the persistent helper and listeners, preserving publication and shutdown failures. Recording cap/error completion clears only its matching recording and recalculates capture demand before publication. One publication may be pending per session; starting another recording waits for it to finish. Failed frame subscribers release their viewer demand exactly once. Snapshot deadlines use an injected scheduler. A bounded transform rejects unterminated stdout/stderr lines before readline can accumulate them.

## Testing and operation

Host tests exercise bounded codecs, DPI and negative-origin mapping, tile changes, frame pacing, tree caps, reference retention and typed errors through public APIs. Fake-helper process tests exercise negotiation, IPC, typed failures, legacy compatibility and scoped semantic tools. Cross-check both Windows MSVC targets; x86_64 must pass with zero warnings. Run static repository checks before opening the PR. Per the repo owner's updated rule, behaviour tests, benchmarks and mutation runs are deferred to merge; document at least eight intended mutation cases as not executed.

Non-gating benchmark sources cover host codec/hash/tree throughput, mailbox retirement, frame/UI translation, line bounds and rich MCP image validation. Their results and peak RSS need a run at merge. Real Windows idle CPU, changing-window CPU at 10 fps, GPU/encode latency, large-app tree latency and RSS remain unmeasured until Windows CI or a test machine is available. The helper README contains the exact manual test and measurement plan. Cross-compilation is not runtime verification.

Primary references: [WGC window creation](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow), [free-threaded capture](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded), [UIA caching](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients), [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).
