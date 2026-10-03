# Windows computer-use helper

Rust source for Windows 10 1903+ and Windows 11, x64 and ARM64. Real Windows runtime behaviour is **untested**. macOS host tests and MSVC cross-checks do not verify WGC, GPU scaling, SendInput, UIA, named-pipe ACLs or Authenticode. See [ADR 0037](../../docs/adr/0037-windows-screen-helper.md).

## Build and install

From this directory, with rustup and Visual Studio Build Tools on Windows:

```sh
rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc
cargo build --release --target x86_64-pc-windows-msvc
```

The checked-in Cargo configuration links the CRT statically. The executable uses Windows system DLLs, no separately installed Rust, VC runtime, encoder DLL, PowerShell or screenshot utility. `Cargo.lock` pins the dependencies. Windows ARM64 builds need the ARM64 MSVC tools.

Release packaging installs `ace-screen-helper-windows.exe` once at `<ace data dir>\helpers\screen\`. Use `screenHelperPath(dataDir, "win32")` to resolve this path. Set `ACE_SCREEN_HELPER` to that installed path for the daemon. Launching never builds, copies, patches or signs it. Sign release binaries with Authenticode and a timestamp using the release publisher's certificate. Keep the path and publisher stable across releases. Development builds use one stable installed path and signing certificate. Do not replace a running helper. Packaging and certificates are outside this PR.

For macOS release packaging, install the helper as `AceScreenHelper.app` with an Info.plist and stable bundle ID `dev.ace.screen-helper`. Sign with Developer ID and hardened runtime, notarize and staple the bundle. Use a persistent development signing identity. The existing Swift development build script is unchanged by this Windows work.

## Protocol

Launch once per daemon host lifetime:

```text
ace-screen-helper-windows.exe --endpoint pipe:\\.\pipe\ace-screen-<random>
```

The helper owns a byte pipe, limits it to one client, rejects remote clients and applies `D:P(A;;GRGW;;;<current-user-SID>)`. The protected DACL contains only that user. Duplex pipe access accommodates Node's pipe client; only helper-to-daemon bytes are used. The pipe exists before `hello` is acknowledged. Close stdin to exit. Logs go to stderr; stdout is reserved for newline JSON replies.

Commands carry `version`, `id` and `op`. v2 supports `hello`, `permissions`, `targets`, `start`, `stop`, `action`, `watch`, `ui.tree`, `ui.find`, `ui.act`, `pointer.move`, `pointer.click`, `pointer.drag`, `key.press`, `text.type` and `scroll`. v1 start/stop/permissions/targets/action commands and JPEG headers still work. v1 replies have string errors; v2 replies have `{code,message}` errors. The daemon keeps macOS v1 by default; setting `protocolVersion: 2` opts into a v2 helper.

`start` retains the v1 `sessionId`, `target`, `allowlist`, `fps` fields. Windows window IDs are HWND values, display IDs are HMONITOR values. Inventory `bundleId` means the lowercase full executable path on Windows. Only window and display targets are supported. A display requires an explicit `monitor:<displayId>` approval in both `allowlist` and `target.bundleIds`, because WGC captures every visible app on that monitor. A monitor is view-only. App aggregation/filtering is not supported.

`watch {active:false}` releases the WGC session and D3D resources while retaining target policy and UI references. `watch {active:true}` reacquires capture, forces a fresh initial frame and continues sequence numbers. The daemon uses this additive command to suspend when there are no viewers, recordings or pending actions, and resumes for a screenshot. Screen snapshots do not require permanently running capture.

Windows v2 start/watch requests and frames carry `captureGeneration`, allocated by the daemon across the host lifetime. Stop/pause retires queued packets. An in-flight packet finishes intact, including under pipe backpressure, and the daemon discards it by session/generation. Resume clears cached pixels and accepts only a post-resume generation. A raw client omitting the optional field gets generation 1; v1 headers are unchanged.

`ui.tree {target,maxDepth,maxNodes}` uses the active approved window. Depth is counted from root at zero, capped at 32; nodes visited are capped at 2048, including pruned offscreen branches. Names, values, descriptions and query fields are capped at 256 UTF-16 units. An aggregate serialized-byte budget also prunes the tree and reports truncation before it can exceed the reply cap. Password values are omitted. `ui.find {query:{role?,name?,text?},limit}` stops early at the result limit, at most 128, and reports conservative truncation. The runtime-ID reference cache holds at most 4096 elements. A reference survives repeated reads, but eviction, target replacement or element removal makes it stale; ref identifiers never get reused. UIA patterns support press, focus, setValue, scroll, expand and select. `expand` defaults to expand and `value:false` means collapse. `scroll.value` is `{dx,dy}`, using small semantic increments by sign. Only absent semantic support allows an input fallback at the element centre, reported with `fallback:true`.

Input coordinates are window-local logical points, including the non-client frame. Capture `scale` is output pixels per logical point. Divide screenshot coordinates by scale; UI bounds already use points. The helper queries current DWM bounds and DPI on every input, supports negative virtual-desktop origins and refuses a covered pointer point. Drag uses x/y and toX/toY. Named keys use Enter, Tab, Escape, Space, Backspace, Delete, Insert, arrows, Home/End, PageUp/PageDown, F1-F24 or A-Z/0-9. Modifiers are control/shift/alt/meta. Legacy macOS key codes have a limited explicit translation; use portable keys for Windows. Unicode text inserts UTF-16 units via KEYEVENTF_UNICODE and preserves surrogate pairs. Input requires the captured window to be foreground. It does not activate windows or elevate the helper.

Permissions are screen `n/a` and input `granted` on the default interactive desktop. A locked, secure or UAC desktop returns busy. Stale window/element handles return target_gone. UIPI can reject input to elevated apps and is reported as busy. WGC item closure, device failure and frame-pipe disconnect terminate the helper; the daemon clears cached frames and controller ownership. Recovery requires stopping the failed session and explicitly starting another.

Frames use a four-byte big-endian header length, UTF-8 JSON, then exactly `bytes` JPEG bytes. v2 headers contain version, sessionId, seq, ts, width, height, scale, codec, bytes and optional dirtyRects in output pixels. Headers cap at 4096 bytes, JPEGs at 8 MiB, output at 3840 by 2160, fps at 30. Control input caps at 64 KiB and replies at 1 MiB. CacheRequest fetches properties and patterns per element; it never asks UIA to allocate an uncapped subtree. Output keeps one in-flight packet and one newest pending packet. Frames remain in memory.

WGC frame-arrived events wake the capture worker. D3D11 video processing scales BGRA before staging readback. Output buffers and GPU resources are reused within a capture session. XXH3 tile hashes compare delivered pixels before JPEG encoding, which suppresses duplicate frames on Windows versions without usable dirty rectangles. Pacing uses one deferred wakeup when a final change arrives inside the fps interval. There is no idle polling timer. JPEG uses the statically linked `jpeg-encoder`, with host-testable decoding and bounded image dimensions. The choice trades WIC COM stream setup for a portable encoder; hardware scaling remains in D3D11. WGC may deliver duplicate frame events on some drivers. Idle CPU must be measured on Windows before claiming approximately 0%.

## Host verification at merge

```sh
rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc
cargo check --target x86_64-pc-windows-msvc
cargo check --target aarch64-pc-windows-msvc
cargo test
cargo fmt --check
cargo bench --bench core
```

If Homebrew Cargo invokes a different rustc than rustup, put the rustup toolchain's bin directory first in PATH or set `RUSTC="$(rustup which rustc)"`. Cross-checking does not link an exe on macOS. Tests run on the host for codecs, Unicode event planning, coordinate mapping, hashing, pacing, tree pruning/search, ref eviction, fallback policy and error mapping. `bun run test packages/screen --maxWorkers=2` exercises real fake-helper processes and local IPC, including Windows process ownership, negotiation and semantic tools. See `bench/results.md` for the pending measurement matrix and `bench/mutations.json` for mutation cases, marked not executed. The repo owner requires tests and benchmarks to run only at merge; the final revision has static checks only.

## Exact Windows manual test plan

Use an unlocked normal-user Windows 10 1903 machine and Windows 11 x64 and ARM64 machines. Record build number, driver, GPU, monitor layout, scale factors and helper file hash. Build release on each architecture, verify the Authenticode signature, inspect imports with `dumpbin /dependents` for system DLLs and confirm no VC redistributable is needed.

1. Start the daemon with ACE_SCREEN_HELPER set to the installed signed exe. Run permissions and targets twenty times. Check Task Manager shows one helper PID and the executable's file hash and modification time stay unchanged. Stop/start screen sessions and verify PID reuse. Close the daemon and verify helper exit and pipe cleanup.
2. Open Notepad as a normal user. Enable screen access, approve its exact lowercase executable path from inventory, select its window and start at 10 fps. Decode the binary pipe with `FrameDecoder` and view the JPEG. Confirm only that window is captured. Deny the path, try an incorrect path and verify capture/input denial. Revoke approval while viewing and verify capture stops and cached screenshots disappear.
3. Leave Notepad unchanged for 60 seconds after its caret stops blinking, count frame packets and record process CPU, kernel/user time and RSS. No identical frames should be sent. Disable subscribers and recordings and verify WGC's capture indicator disappears and CPU returns to the idle baseline. Request a screenshot after changing text while paused and verify fresh pixels and a continuing sequence number.
4. Animate or continuously edit a 1280x720 window at 10 fps for 60 seconds. Repeat at 4K and above 4K, confirming output stays within the cap and D3D scaling works. Measure frame-to-JPEG latency and encode latency with WPR/ETW or an instrumented release build around GPU readback and the encoder. Record CPU and RSS. Throttle the pipe reader, then resume: packets must remain whole, memory must stay bounded and the newest pending frame must replace older pending frames.
5. Test two monitors at 100%, 150% and 200% DPI, with the second monitor to the left and above the primary. Move Notepad between monitors and resize it while streaming. Read UI bounds and click their point centres, then click a visual screenshot location divided by scale. Test boundary and negative coordinates; out-of-window input must return bounds. Put another window over the point and confirm busy instead of clicking it. Make another app foreground and confirm keyboard/pointer refusal.
6. Type `Hello, 你好, é, 😀` and multiline text into Notepad, confirming exact Unicode and surrogate pairs. Test Enter, Tab, Ctrl+A, Shift+arrows, F keys, horizontal/vertical scroll and a drag selection. Verify no stuck keys or mouse buttons after a blocked input batch. Run an elevated Notepad and confirm UIPI refusal. Trigger UAC, lock Windows and switch to another desktop; permissions/actions must report busy or target_gone and must never type into the secure desktop.
7. Use Calculator, Explorer and a large browser window for ui.tree at depth 0, 1, 8 and 32 with node caps 1, 20 and 2048. Verify truncation, offscreen pruning and absence of password values. Record median/p95 tree latency on the large app over 100 reads. Repeat ui.find by role/name/text and confirm bounded results and early stopping. Change layout and repeat reads; surviving controls keep refs. Delete a control, evict refs with a large tree and replace the target: stale refs must return target_gone.
8. At merge, run `cargo test --target x86_64-pc-windows-msvc cached_edit_values_offer_set_value_only_when_writable -- --ignored` from an unlocked interactive desktop to verify cached properties, a real Value mutation and readonly denial. Run `cargo test --target x86_64-pc-windows-msvc unsupported_invoke_on_an_edit_uses_a_reported_input_fallback -- --ignored` to exercise an actual unsupported UIA pattern and synthesized fallback; this test moves the pointer. Exercise Invoke, writable Value, Scroll, ExpandCollapse including collapse, and SelectionItem against controls known to expose each pattern. Verify their visible state changes and fallback:false. Force provider timeout or denial and verify no fallback click. Perform human takeover during queued semantic/input actions; queued agent actions must be rejected.
9. Approve `monitor:<displayId>` explicitly and capture each monitor. Confirm no monitor capture without this approval and no monitor input. Display removal, window closure, minimize/restore, resolution changes, helper crash and driver reset must fail or recover explicitly without stale frames or restored agent ownership.
10. While capture runs, use Process Explorer or a native pipe probe to inspect the pipe's protected DACL. Confirm only the owner SID has read/write grants, a different local user cannot connect and a remote named-pipe client is rejected. Confirm a second client cannot become a producer. Send an oversized command, malformed frame/request and unsupported version to isolated test instances and verify bounded failure.
11. Throttle the pipe until a packet is partially written, stop and restart on another window, then drain it. Verify the old packet is complete but discarded, the new session stays live and all accepted frames use its generation. Pause with another queued packet, edit while paused, resume and request a screenshot; verify post-resume pixels and generation with continuing sequence numbers. With identical RGB pixels and a changed DPI/scale, verify the new metadata is emitted.
12. Hold recording publication unresolved while stopping a session. Verify native capture ceases and the indicator turns off only after cessation, before publication resolves. Reject publication during daemon close and verify actual helper exit. Hit the recording cap with no viewers, verify capture pauses and another recording is possible after completion. Disconnect the last viewer during a send and verify capture pauses.
13. Open a provider MCP lease with `screen` capability for a real canonical thread/agent and delegate through the admin screen bridge with both IDs. Verify all eight exact tool names in tools/list, UI tree reads and semantic changes in tools/call, and JPEG image content larger than 256 KiB. A lease without `screen`, another thread using the same agent ID and a caller after human takeover must be refused. Confirm schema/size failures and cancellation do not expose late pixels.

Publish the Windows measurements with hardware details: idle CPU, changing-window CPU at 10 fps, encode and capture latency median/p95, large-app tree latency median/p95, steady/peak RSS and packet counts. Those entries are currently unmeasured, not zero.
