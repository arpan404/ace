# Static review of the Windows helper

Final revision reviewed on macOS on 2026-10-02. Tests, benchmarks, mutation runs and runtime probes were not executed after the repo owner's updated rule. Every runtime assertion below needs run at merge, or an interactive Windows machine where noted.

Static checks completed:

- `bun run typecheck`, `bun run lint`, `bun run fmt` and `bun run check:size`.
- `cargo check --all-targets` on the macOS host, compiling tests and benchmark source without executing them.
- `cargo check --all-targets --target x86_64-pc-windows-msvc` and the ARM64 equivalent, with zero warnings and warnings denied in the crate.
- `git diff --check`.

The Homebrew Cargo on this host needs rustup's compiler selected explicitly with `RUSTC="$(rustup which rustc)"`; both MSVC target standard libraries are installed. Cross-checks do not link or run a Windows executable.

The review traced command limits, typed replies, frame sizing, D3D resource reuse, capture event wakeups, pacing and hash state, COM teardown order, SendInput coordinate planning, UIA cache properties, tree budgets and reference eviction. It also traced helper ownership, pause/resume, fresh snapshots, approval revocation, controller changes and authenticated daemon access. Corrections include cached ValueIsReadOnly, matching UTF-16 string/query/error limits, aggregate tree byte caps and a post-read ownership check. Screen WebSocket access requires admin scope after merging remote access; read/operate tokens cannot create a state watcher or change approvals.

Written behaviour coverage, not executed:

- Fragmented commands preserve Unicode and reject incomplete/oversized lines; replies retain correlation, versioned errors and size caps.
- JPEG packets delimit exact payload bytes and preserve scale; the written test decodes the encoded JPEG.
- Logical points map through DPI and negative monitor origins; invalid coordinates and output sizes fail.
- Equal tile hashes suppress frames; changed edge tiles and resized buffers produce damage.
- Pacing retains the last change and preserves sequence numbers across capture resume.
- Tree depth/node/byte caps bound provider work, prune offscreen branches and report truncation.
- Search stops at its result limit, returns flat nodes and accepts multibyte queries within the shared UTF-16 cap.
- References survive refresh, evict within the cap and cannot alias stale refs after target replacement.
- HRESULTs distinguish denial, stale elements, unsupported patterns, contention and timeouts; Unicode error messages fit the wire limit.
- Unicode input preserves surrogate pairs and paired releases; invalid drag/key batches fail before injection.
- Only unsupported semantic patterns permit an explicitly reported bounds-centre fallback.
- A fake v2 helper exercises negotiation, fragmented IPC, typed errors, process reuse, fresh screenshots and capture demand.
- Semantic tools change observable fake control values; ownership changes reject actions and delayed UI reads.
- Crash recovery clears frames and controller state and starts a replacement helper explicitly.
- Paired read/operate devices cannot observe screen state or grant approvals; the local admin can list sessions.
- Interactive Windows tests check actual Value mutation, readonly denial and input fallback from an unsupported UIA Invoke pattern. They are ignored on unattended machines; exact invocations are in the manual plan.
- Native mailbox retirement and daemon generation checks discard old pending/in-flight packets across backpressured restarts and pause/resume.
- Stop waits for native cessation before publication and preserves both failures; shutdown awaits actual helper exit after rejected publication.
- Recording auto-caps and failed viewers release capture demand through public ScreenManager APIs.
- The real daemon HTTP MCP endpoint lists exact screen tools, serves image content above 256 KiB and denies missing capability, another thread with the same agent ID and human takeover.
- Public MCP registry tests reject malformed/oversized content and late results after credential revocation.
- POSIX helper output is bounded before readline, spawn failure removes the actual socket directory, and snapshot deadlines use an injected scheduler.
- Public UI tree/find tests reject over-cap or invalid replies; screenshots assert exact payload bytes.
- Event wake policy retains the final event until its deadline without resubmission; scale-only changes invalidate metadata and duplicate events respect pacing.

See `mutations.json` for 44 intended mutations. Each is marked **not executed (tests run at merge)**. Performance sources are present, but all throughput, latency, CPU and RSS numbers remain pending in `results.md`. No runtime claims follow from static compilation.

Real Windows behaviour is untested. The helper README gives the exact Windows 10/11, x64/ARM64 manual plan for WGC, D3D11 scaling, DPI, Unicode, secure desktops/UIPI, UIA patterns, owner-only DACLs, backpressure and resource measurements.

Scope limits: the existing macOS helper remains v1 and Linux helpers are outside this Windows change. Windows supports one active window or explicitly approved view-only monitor; app aggregation is unsupported. Signing/install packaging is documented rather than executed. All eight exact screen tools now register automatically with a configured daemon screen manager. MCP credentials require the screen capability and delegation bound to both thread and agent IDs. Rich MCP content has an independent validated 12 MiB cap; existing structured tools keep their 256 KiB cap.
