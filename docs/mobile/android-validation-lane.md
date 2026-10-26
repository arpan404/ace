# Android validation lane (A00.03)

Task A00.03 audit. Reference commit `b92d9d2618`;
plan [docs/plans/android-ios-parity.md](../plans/android-ios-parity.md);
ledger [docs/plans/android-ios-parity-progress.md](../plans/android-ios-parity-progress.md).
Read-only: no app, config, CI, or harness file was changed, installed, built,
or executed beyond metadata/version/list inspection in this checkout.

## 1. Authority resolution (AGENTS.md vs Android README)

- `AGENTS.md` requires `bun run check` to pass before a task is complete.
- [apps/android/README.md](../../apps/android/README.md) (lines 94-96) scopes local
  static checks to format/lint and `bun run typecheck`, and says to run no Vitest
  or root checks on the shared machine.
- Resolution: **no waiver.** Scoped checks run on demand locally (§3a); the **full
  `bun run check` runs serialized in CI** (a true full gate, not the current
  `check.yml`) and at a scheduled integration point, never as an unbounded
  background run on the shared Mac. Unrun checks are reported incomplete, not passed.

## 2. What exists today (with source)

| Lane                               | Location                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Status                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Scoped Android typecheck           | [apps/android/package.json](../../apps/android/package.json) (`tsc --project tsconfig.json`, `GOMAXPROCS=2`, incremental to `.cache/`); root `scripts/typecheck-projects.ts` discovers `apps/*/tsconfig.json`                                                                                                                                                                                                                                                                                                                                     | Exists                                                    |
| Root checks incl. Android          | `bun run check:deps` lists `apps/android/src` and `apps/android/modules/ace-native/index.tsx` (`.dependency-cruiser.cjs`); `check:size`, `fmt:check`, `lint` cover the tree                                                                                                                                                                                                                                                                                                                                                                       | Exists                                                    |
| Unit-test slot for Android         | `vitest.config.ts` unit project includes `apps/*/src/**/*.test.ts`; today only `apps/android/src/composer-draft.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                          | Exists, one file                                          |
| Fixture daemon                     | [apps/android/scripts/fixture.ts](../../apps/android/scripts/fixture.ts) (`bun run fixture`), loopback `127.0.0.1:4345`, `GET /metrics` reports `replayAdmissions` for `origin.commandId` starting `android-spike-`; `GET /admissions?threadId=stream-thread&probe=...` ([fixture-admissions.ts](../../apps/android/scripts/fixture-admissions.ts) `admissionCommandIds`) reports `{commandIds}` for exact-probe canonical UI admissions including random-UUID sends that the `/metrics` replay filter cannot see                                 | Exists                                                    |
| Debug native build                 | [apps/android/README.md](../../apps/android/README.md): `bun run prebuild`, `gradlew :app:assembleDebug --max-workers=4 --no-daemon -PreactNativeArchitectures=arm64-v8a`, Metro port 8083                                                                                                                                                                                                                                                                                                                                                        | Exists (docs)                                             |
| Spike instrumentation shell        | [benchmark/FixtureSendScenario.kt](../../apps/android/benchmark/FixtureSendScenario.kt) scenario `fixture-send` + helper driven by [benchmark/SpikeInstrumentation.kt](../../apps/android/benchmark/SpikeInstrumentation.kt) (`scenario=fixture-send`, `probeText`) via native platform `Instrumentation`/`UiAutomation` (no UIAutomator dependency) + [plugins/with-ace-probe.ts](../../apps/android/plugins/with-ace-probe.ts): `:app:assembleDebugAndroidTest`, `adb install -t`, `am instrument -w -e scenario fixture-send -e probeText ...` | Exists (sources; no passing run yet)                      |
| Expo prebuild plugins              | `plugins/with-ace-host.ts` (dev support bound to `BuildConfig.DEBUG`), `with-ace-network.ts` (cleartext denied except debug loopback `127.0.0.1`/`localhost`/`::1`), `with-ace-probe.ts`                                                                                                                                                                                                                                                                                                                                                          | Exists                                                    |
| Fixture UI/native behavior harness | [benchmark/FixtureSendScenario.kt](../../apps/android/benchmark/FixtureSendScenario.kt), [apps/android/scripts/fixture-send.ts](../../apps/android/scripts/fixture-send.ts) (host driver), [apps/android/scripts/fixture-admissions.ts](../../apps/android/scripts/fixture-admissions.ts) (observer); manual README procedure remains background only                                                                                                                                                                                             | Exists (sources; no passing run yet, A00.05 owns the run) |
| Focused Android CI lane            | [.github/workflows/android-lane.yml](../../.github/workflows/android-lane.yml) (336 lines; latest wall-clock bounds and static controls)                                                                                                                                                                                                                                                                                                                                                                                                          | **Exists (sources; static only, never run — A00.06)**     |
| Release-like build command         | `rg` over `apps/android` finds no `assembleRelease`/`bundleRelease`/EAS/signing path (`release.yml` signs nothing per ADR 0041)                                                                                                                                                                                                                                                                                                                                                                                                                   | **Missing** (owned by A01.01/A15.06)                      |

## 3. Exact bounded commands (cwd-prefixed; `ROOT` = worktree root)

### a. Scoped local checks (allowed on the shared Mac)

```sh
# cwd: ROOT/apps/android
bun run typecheck
# cwd: ROOT
bun run check:deps
bun run fmt:check
bun run lint
bun run test -- apps/android   # listed for completeness; per README stays in CI on the shared machine
```

### b. Debug native build + fixture (one driver, one device, §5)

```sh
# cwd: ROOT/apps/android (shell exports ANDROID_HOME + platform-tools/emulator first)
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
bun run prebuild
# cwd: ROOT/apps/android/android
./gradlew :app:assembleDebug --max-workers=4 --no-daemon -PreactNativeArchitectures=arm64-v8a
```

Then `bun run fixture` + `bun run start` (each cwd `ROOT/apps/android`, separate
terminals), install the APK, `adb reverse` ports 8083/4345. Instrumentation
variant: same Gradle invocation with `:app:assembleDebugAndroidTest`,
`adb install -t`, then the 600 s `am instrument` command from §2.

### c. Full completion gate (CI / serialized integration only)

`bun run check` = `fmt:check` + `docs:protocol --check` + `lint` + `check:size` +
`check:annotate` + `check:extension` + `check:ui` + `check:deps` + `typecheck` +
`test` + `check:perf` (root `package.json`). Plus `bun run typecheck:full` as the
CI safety net. Never parallel with another Gradle run or device job.

**`check.yml` is a subset, not the full gate.** It must not be cited as literal
or equivalent completion evidence. Verified against root `package.json` and
[.github/workflows/check.yml](../../.github/workflows/check.yml):

- Omitted: `check:annotate` (browser-annotate overlay build check) — no step.
- Omitted: `check:extension` (browser-extension + video-extension build checks) — no step.
- `check:perf` incomplete: runs daemon bench, `check:static` web-perf subset, and a
  macOS-conditional device check, but not `packages/browser/bench/video-link.ts`
  nor the full `web-perf check` (browser/memory/long-thread/markdown); PTY bench is
  `continue-on-error` informational; relay image build is Linux-only.
- Extra but not compensating: `typecheck:full` and regression probes are a superset
  only for typechecking; the single serialized `bun run check` gate itself never runs.
- Requirement: A00.06 (or the integration point) runs the true full gate and reports
  each omitted portion pass/fail; anything unrun is incomplete, never "passed".

### d. Audit-time vs current setup

- Audit-time (A00.03, commit `b92d9d2618`): metadata only — `bun --version` (1.4.3),
  `node --version` (v26.7.0, satisfies `engines: node >= 24`),
  `java -version` (24.0.2), `emulator -version` (37.2.12.0),
  `adb --version` (37.0.1), `avdmanager list avd` (shows `Ace_Android`,
  `Ace_Tablet`), `ls`/`rg` reads. **Not executable at audit time:** anything
  needing installs or builds. The checkout had **no** `node_modules` (root or
  `apps/android`), **no** generated `apps/android/android/` (ignored per
  [apps/android/.gitignore](../../apps/android/.gitignore)), and **no** `~/.gradle`
  cache. No device was booted and no test/build ran in the audit.
- Current setup (this worktree, post-audit): `bun install --frozen-lockfile` done,
  `bun run prebuild` done (generated `apps/android/android/` present, ignored),
  scoped `bun run typecheck` (cwd `ROOT/apps/android`) passed. SDK packages are
  installed side by side with effective compile/target 36, build-tools 36.0.0,
  NDK 27.1.12297006, CMake 3.30.5 (prebuild-generated `app/build.gradle`
  `rootProject.ext` + SDK packages; transitive CMake 3.22.1 and build-tools 35.0.0
  also present); Gradle 9.3.1 via
  `android/gradle/wrapper/gradle-wrapper.properties` with JDK 24 supported
  (shared-Mac `java -version` 24.0.2 line above). **Native compile is verified; no
  device pass is claimed:** per
  `/tmp/ace-android-native-verify-20261026-125851/report.json`, target configure
  exit 0 (173.33 s), prebuild exit 0 (0.87 s), assembleDebug +
  assembleDebugAndroidTest exit 0 (198.70 s), both APKs; scoped
  `JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED` fixed the JDK 24 prefab
  path with no SDK changes/orphans. Earlier history: first native build FAILED in
  353.5 s (274 tasks, `:react-native-screens` + `:react-native-worklets`
  `configureCMakeDebug[arm64-v8a]`, no APKs;
  log `/tmp/ace-android-m00-build-gradle-20261026-084228.log`). No booted-device
  run and no `/admissions` admission observed — real-device UI positive/negative
  runs are still open. Screens/devices Ace groups are currently disabled; no
  emulator was booted by this session.
- Generated files seen in _another_ checkout (prebuild output, `build/`, `.gradle/`)
  were explicitly out of scope at audit time: not audited, not cited as evidence.
- Existing (A00.06, source only, never run): the `android-lane.yml` workflow (§7,
  336 lines).
  The native SEND runner + host driver sources now exist (§6); the run itself does
  not. No release-like build command exists to quote.

## 4. Bounded setup subtask (must precede any native verification)

New explicit prerequisite, owned by A00.05 dispatch (reused as A00.06 CI steps):

```sh
# cwd: ROOT
bun install --frozen-lockfile
# cwd: ROOT/apps/android
bun run prebuild
```

Neither step ran in the A00.03 audit (it forbids installs/builds); both are done in
the current setup per §3d. The native run itself is still unclaimed (§3d, §8).
Never run alongside another Gradle/device job.

## 5. Shared-machine resource budget (plan §Execution rules + README)

One Gradle build, `--max-workers=4`; one driving job per shared device; only
`Ace_Android` (phone) and `Ace_Tablet` (tablet) at `/Users/lucifer/Library/Android/sdk`;
never create temp AVDs or wipe another app's data. Metro 8083, fixture loopback
`127.0.0.1:4345`; coordinate active Ace threads before any device use.

## 6. A00.05 packet (native instrumentation SEND harness)

- Goal: one real functional scenario on `Ace_Android` — launch → fixture inbox →
  open streaming thread (`stream-thread`, titled "ace CLI phase 2" in
  [src/App.tsx](../../apps/android/src/App.tsx)) → focus composer
  (`accessibilityLabel="Message"`) → enter text → tap send (`↑` in
  [src/Composer.tsx](../../apps/android/src/Composer.tsx), persisted via
  [src/composer-draft.ts](../../apps/android/src/composer-draft.ts) `thread.send`)
  → assert **exactly-one canonical admission** via fixture
  `GET /admissions?threadId=stream-thread&probe=...` `{commandIds}` plus local
  SQLite record → deterministic cleanup. The `/metrics` `replayAdmissions` filter
  (prefix `android-spike-`) cannot observe this send: the real composer mints
  random-UUID `origin.commandId` values, so only the `/admissions` observer
  ([fixture-admissions.ts](../../apps/android/scripts/fixture-admissions.ts)
  `admissionCommandIds`) counts.
- Method: **native instrumentation + adb-driven only** ([benchmark/FixtureSendScenario.kt](../../apps/android/benchmark/FixtureSendScenario.kt)
  scenario `fixture-send` + helper, driven by
  [benchmark/SpikeInstrumentation.kt](../../apps/android/benchmark/SpikeInstrumentation.kt)
  through platform `Instrumentation`/`UiAutomation`/`AccessibilityNodeInfo` —
  explicitly **not** UIAutomator). The scenario drives the real
  inbox/thread/composer screens; host driver
  [scripts/fixture-send.ts](../../apps/android/scripts/fixture-send.ts) takes a
  selected booted `--serial` plus prebuilt `--app-apk`/`--test-apk`, verifies the
  already-running owned fixture (`127.0.0.1:4345`) and Metro (`127.0.0.1:8083/status`),
  owns only the `adb reverse` mappings it adds, installs the APKs, invokes
  `am instrument -e scenario fixture-send -e probeText ...`, polls `/admissions`,
  and cleans up. It never boots/creates/wipes an AVD, never starts the
  fixture/Metro/bundler, and never builds an APK. **Metro auto-bundler gap is
  closed in source only** (A00.05d `benchmark/FixtureDevServer.kt`: sets ordinary
  RN `debug_http_host` to `localhost:8083` then restores; compile passes and both
  APKs build (§3d), native runtime unverified — no device run yet). **An unmounted JS unit/integration
  harness is invalid for this packet**: it cannot touch the inbox/thread/composer UI or prove admission.
- Why new work was required (audit-time): the original `SpikeInstrumentation` default
  path only started `MainActivity` and slept until its deadline — it performed no UI interaction and
  asserted no behavior, so it **could not certify UI behavior**. The
  `fixture-send` scenario branch now exists as source (§2); it has no passing run yet.
- Product-side constraint: **no new test bypass.** Product files
  (`Inbox.tsx`, `Thread.tsx`, `Composer.tsx`, `composer-draft.ts`, `runtime.ts`,
  `storage.ts`) are read-only; no test hooks, IDs, permissions, or
  `INJECT_EVENTS`-style shortcuts. Injection attribution stays in the debug test APK
  via the existing `with-ace-probe.ts` pattern.
- Writable paths (sources now present; run still owned by A00.05):
  `apps/android/benchmark/FixtureSendScenario.kt` (scenario + helper),
  `apps/android/benchmark/SpikeInstrumentation.kt` (`scenario=fixture-send` branch),
  `apps/android/scripts/fixture-send.ts` (host driver: install/reverse/instrument/poll/assert/cleanup),
  `apps/android/scripts/fixture-admissions.ts` (observer: parse + `admissionCommandIds`),
  evidence note under `docs/verification/android-fixture-send/`; narrowly permitted
  edit limited to the copy block of `plugins/with-ace-probe.ts` to ship the new runner.
- Observable pass: scenario completes within a 15-minute device timeout with zero
  `/admissions` hits before and exactly one after (`{commandIds}` length 1);
  negative control (observe a different probe than the sent one) fails the run.
  Fail: any hang, duplicate admission, or leftover emulator/app state needing manual cleanup.
- **Not M01.** This packet is one functional send. The M01 120-native-key input
  workload with FrameMetrics p95/coverage gates (README "Measurement") is a separate
  performance gate with its own evidence; neither packet passes by citing the other.

## 7. A00.06 packet (focused Android CI lane)

- Goal: a workflow that fails on a deliberately broken fixture SEND behavior.
- Allowed path: new `.github/workflows/android-lane.yml` only; all other CI/app files read-only.
- Trigger/permissions/isolation: `on: pull_request` (never `pull_request_target`);
  `permissions: contents: read`; no secrets; disposable hosted runner
  (`runs-on: ubuntu-latest`); **no shared self-hosted runner executes untrusted PR
  code**. Serialized: single job (or jobs with `needs` chaining, no matrix for native
  work), one Gradle executor, `--max-workers=4`, `concurrency` group with
  `cancel-in-progress`, bounded timeout ≤ 45 minutes.
- Steps (cwd-prefixed): `bun install --frozen-lockfile` (cwd `ROOT`) →
  Android typecheck (cwd `ROOT/apps/android`) → `check:deps` (cwd `ROOT`) →
  scoped `vitest run apps/android` → `bun run prebuild` (cwd `ROOT/apps/android`) →
  `assembleDebug` + `assembleDebugAndroidTest` (cwd `ROOT/apps/android/android`) →
  **install/launch/drive/assert via the A00.05 runner (instrumentation required,
  not optional; assert via `/admissions`, not `/metrics` replay)** → full `bun run check` ownership statement per §3c (run the true
  gate or report each unrun portion incomplete).
- Observable pass/fail: green lane on the reference tree; red lane when the
  negative-control fixture break is injected. Native build work is never matrixed.
- Host/toolchain shape: the proposed lane runs on Ubuntu `x86_64`, which differs from
  the shared Mac `arm64-v8a` shape (README Gradle flag
  `-PreactNativeArchitectures=arm64-v8a` is the Mac-local value; the lane pins its
  own arch explicitly and never inherits it silently). Provisioning is a disposable
  hosted AVD only — **never a new shared Mac AVD**, never a temp AVD on the shared
  machine, never a wipe of another app's data. `ANDROID_HOME` platform-tools/emulator
  - `adb reverse` pattern verified (README).
- Toolchain (current setup, §3d): Gradle 9.3.1 via the wrapper with JDK 24 supported;
  SDK packages installed side by side with effective compile/target 36, build-tools
  36.0.0, NDK 27.1.12297006, CMake 3.30.5 (plus transitive CMake 3.22.1 /
  build-tools 35.0.0). **Native compile verified** (target configure exit 0 /
  173.33 s, assemble exit 0 / 198.70 s, both APKs; scoped `JAVA_TOOL_OPTIONS`
  fixed the JDK 24 prefab path; no SDK changes/orphans). **Still unverified until
  a passing lane run** (confirm or file a blocker): AVD image/API details beyond
  the `Ace_Android`/`Ace_Tablet` names; no device pass is claimed here.

## 8. Validation done / not done + remaining blockers

- Done (audit-time): read-only audit of scripts, configs, plugins, instrumentation, Vitest, CI,
  README, AGENTS.md, ADR 0073; metadata-only tool/version/list checks (§3d).
- Done since (current setup, §3d): `bun install --frozen-lockfile`, `bun run prebuild`,
  scoped Android typecheck; A00.05a/b/c/d + A00.06 sources implemented. Native
  compile verified: target configure exit 0 (173.33 s), prebuild exit 0 (0.87 s),
  assembleDebug + assembleDebugAndroidTest exit 0 (198.70 s), both APKs
  (`/tmp/ace-android-native-verify-20261026-125851/report.json`); durable detail
  being written by another owner at
  [native-build-20261026.md](../../verification/android-fixture-send/native-build-20261026.md).
  Host-driver fake-adb boundary rerun `/tmp/a00verify/logs/verify-a00-05c-rerun.log`
  passes ALL 12 cases (incl. 4.3 s timeout, reverse ownership, strong negative) —
  explicitly not an Android native UI pass. Full `bun run check` actually ran and
  stopped early (`/tmp/ace-android-integration-check-20261026.log`): `fmt:check`
  passed on 10,029 files, then `docs:protocol --check` failed on a stale
  `manifest.json` in 4 s; later gates including typecheck, test and perf are unrun
  with a root-cause audit ongoing. No emulator boot, Vitest run, `/admissions`
  admission, or lane run is claimed — reported incomplete, not passed.
- Honest blockers: no device pass yet (compile verified per §3d; real UI
  positive/negative runs open); AVD image/API details unverified beyond names;
  FixtureDevServer helper resolves
  the bundler gap in source only (§6, runtime unverified); A00.06 lane exists as
  source only (336 lines, static, never run); release-like build
  and physical-device gates belong to M01/M15 and stay open. The true full
  `bun run check` stays open; existing CI (`check.yml`) is a subset per §3c.
