# Android parity execution ledger

Plan: [Android full iOS parity](android-ios-parity.md).
Reference: `b92d9d2618481dfd8c77a94c6bcab5a26fa61395`, 2026-10-26.

The user approved milestone execution. The parent orchestrates task packets, review and
integration. Children use OpenCode `opencode-go/muse-spark-1.3-contributor`, effort `xhigh`.
No milestone is complete merely because an agent reports success.

## Current milestone

M00 is open. M01 through M15 remain planned. Production Android startup still uses the
debug fixture; none of the later app capabilities has been certified by this execution.

| Task    | State                                                         | Assignment/evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Next gate                                                                                                 |
| ------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A00.01  | Review                                                        | [87-row capability matrix](../mobile/android-ios-capabilities.md); independent source review applied through child `b8311d4f-4d17-4df6-87e2-14d76d9c1430`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Grant details remain explicit per-action audit work; source inspection is not runtime evidence            |
| A00.02  | Review                                                        | [Navigation specification](../mobile/android-navigation-spec.md); child `e4ff0fa2-c7e8-48be-9bff-e974aea8b91b`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Correct unsupported architecture choices; preserve existing native-stack ownership                        |
| A00.03  | Review                                                        | [Validation lane](../mobile/android-validation-lane.md); independent review corrected full-check and harness assumptions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Final packets must use actual UI send admission, not replay-only metrics                                  |
| A00.04  | Review                                                        | README/report corrections by child `461ad2e8-e278-41d5-b9ea-667a4ef650ab`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Source/link/format review; no GitHub issue closure                                                        |
| A00.03a | Verified                                                      | Frozen install exit 0, 8 seconds; 1,418 packages; workspace and terminal postinstalls passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Manifests and lockfile unchanged                                                                          |
| A00.03b | Verified                                                      | No-install Android prebuild exit 0; package typecheck exit 0; ignored native project generated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Native build not run; missing SDK components need exact verification                                      |
| A00.03c | Native compile verified                                       | Toolchain compatibility audit, child `323a89db-53fc-4c81-95eb-32341e91b138`; effective RN catalog SDK 36 / build-tools 36.0.0 / NDK 27.1 / CMake 3.30.5, AGP 8.12, Gradle 9.3.1, JDK 24; SDK also holds transitive CMake 3.22.1 + build-tools 35.0.0. Native compile gate passed per `/tmp/ace-android-native-verify-20261026-125851/report.json`: target configure exit 0 (173.33 s), prebuild exit 0 (0.87 s), assembleDebug + assembleDebugAndroidTest exit 0 (198.70 s), both APKs; scoped `JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED` fixed the JDK 24 prefab path; no SDK changes/orphans | Device/emulator UI run still open; compile proves no UI/perf                                              |
| A00.05a | Implemented (compile pass; real UI positive pending)          | Fixture-only admission observer, child `11979ccb-6f06-428f-87c4-851ad322d40e`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Observe actual UI random-UUID commands on a booted emulator or device; do not change product command IDs  |
| A00.05b | Implemented (compile pass; real UI positive pending)          | Native send scenario, child `a8b5a871-8259-420d-9641-dac41b80202e`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Drive existing UI through platform instrumentation on a booted emulator or device; no product-side bypass |
| A00.05c | Implemented (compile pass; real UI positive/negative pending) | Host driver for observer and native scenario; fake-adb boundary rerun `/tmp/a00verify/logs/verify-a00-05c-rerun.log` ALL 12 cases pass incl. timeouts 4.3 s, reverse ownership, strong negative — explicitly not an Android native UI pass                                                                                                                                                                                                                                                                                                                                                                 | Device/emulator instrumentation run with exactly-one `/admissions` assertion still open                   |
| A00.05d | Implemented (compile pass; real UI positive pending)          | Test FixtureDevServer helper (`FixtureDevServer.kt`): sets ordinary RN `debug_http_host` to `localhost:8083` then restores; resolves earlier manual-bundler gap in source only                                                                                                                                                                                                                                                                                                                                                                                                                             | Native runtime unverified (compile passes; no device run yet)                                             |
| A00.06  | Implemented (source/static plus hosted run pending)           | Focused Android CI lane (`.github/workflows/android-lane.yml`) — source/static plus hosted run pending; no CI green claim, no hardware UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Lane has never run green; CI attempts below; full `bun run check` still unrun to pass                     |
| A01.01  | Implemented (source/static; compile/device gates pending)     | Execution-mode boundary (`09e49e018` JS/config, `fb8f01b95` native): validated mode reader, measurement build type, pinned production entry, per-variant input hooks; evidence [a01-01-boundary.md](../../verification/android-measurement-variant/a01-01-boundary.md) — 14 unit tests pass, typecheck/lint/fmt/prebuild green; Gradle assemble, device positive/negative, artifact verifier, and full check unrun                                                                                                                                                                                         | Coordinated `assembleMeasurement`/`assembleRelease` plus device runs; verifier slice (task 9) is open     |

## Validation and resource ownership

- A00.03c native compile is verified; A00.05a/b/c/d are implemented with a compile
  pass but their real UI positive/negative runs are pending, and M00 stays open.
  Native compile gate passed per `/tmp/ace-android-native-verify-20261026-125851/report.json`:
  target configure exit 0 (173.33 s), prebuild exit 0 (0.87 s), assembleDebug +
  assembleDebugAndroidTest exit 0 (198.70 s), both APKs. Scoped
  `JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED` fixed the JDK 24 prefab
  path; no SDK changes/orphans. No UI/perf claim. Durable detail is being written
  by another owner at
  [native-build-20261026.md](../../verification/android-fixture-send/native-build-20261026.md).
  Earlier history: first native build FAILED in 353.5 s (274 tasks,
  `:react-native-screens` + `:react-native-worklets` `configureCMakeDebug[arm64-v8a]`,
  no APKs; log `/tmp/ace-android-m00-build-gradle-20261026-084228.log`).
- Frozen dependencies are installed. Prebuild and scoped Android typecheck passed.
  Passing Gradle compile (both APKs) is now recorded, but no emulator boot,
  application test, `/admissions` admission, complete Vitest pass, or native UI
  pass has run yet (Vitest ran partially for 900 s; physical hardware
  certification belongs to M01). Screens/devices Ace groups are currently disabled; no emulator was booted by
  this session. Latest host-driver evidence is the fake-adb boundary rerun only
  (`/tmp/a00verify/logs/verify-a00-05c-rerun.log`, ALL 12 pass), explicitly not an
  Android native UI pass.
- Shared device use requires coordination. No device reservation is currently held.
- Full `bun run check` history, preserved as resolved-then-rerun. First run
  (`/tmp/ace-android-integration-check-20261026.log`): `fmt:check` passed on 10,029
  files, then `docs:protocol --check` failed on a stale `manifest.json` in 4 s.
  Root cause: our `bun.lock` devDep fingerprint. The existing generator refreshed
  only the `docs/protocol/manifest.json` input; all 1,136 rendered file hashes
  unchanged, and `docs:protocol --check` now passes. Rerun (owner `48944c02`,
  `/tmp/ace-android-integration-check-20261026-rerun.log`) ended at 900 s during
  web tests with no assertion fail reported — not a pass. Passed: fmt,
  docs:protocol, lint, size (9,063 files), annotate, extension, UI (80
  advisories), deps, typecheck. Test incomplete (SIGTERM at 900 s);
  perf and typecheck:full unrun. The authorized further serialized integration run
  (repo DEFAULT, 4 workers, 1,800 s) is running — not passed. Native/device gates
  stay open (physical hardware
  certification belongs to M01). M00
  stays open; M01 through M15 remain planned, with the A01.01 packet proposed in
  [android-measurement-variant.md](../mobile/android-measurement-variant.md)
  (reviewed, not implemented).
  Current startup still uses the debug fixture; no production-parity claim is made.
- CI lane attempts (hosted, no green claim, no hardware UI): first run 40376025273
  failed on missing node-gyp (fixed via pinned bootstrap); second run 40376716112
  failed at the KVM gate; third run 40377312535 at source head `bc219d4b2` failed after Gradle reported BUILD
  SUCCESSFUL in 9m8s with both hosted debug APKs assembled: step 17 stopped
  before launch because `ci-ace-android` was absent from `emulator -list-avds`,
  so the native UI positive/negative gates were skipped. KVM was present
  (`root:kvm`, mode 0660) and its access bootstrap passed; SDK/image, the AVD
  create command, scoped typecheck, dependency checks, focused Vitest, and
  prebuild passed, but the creation step did not establish successful discovery.
  A new workflow fix aligns `ANDROID_USER_HOME`, `ANDROID_EMULATOR_HOME`, and
  `ANDROID_AVD_HOME` under `RUNNER_TEMP`, explicitly sets the creation path, and
  asserts registration/config/discovery before Gradle; its hosted validation is
  pending, not a confirmed root-cause claim.
- User-requested small-progress PR created:
  [PR #1450](https://github.com/arpan404/ace/pull/1450). Parent owns Git push.
- Workspace hygiene: three settled worktrees removed, branches kept; untracked Windows
  source backed up at `~/.ace/cleanup-backups/windows-app-audit-20261026`. The Windows
  ISO was not located — no delete is claimed. Data volume ≈46Gi available after build.

## Review findings resolved or carried forward

- Corrected inventory claims about persistent drafts, the 2,200-item spike cap, mutation grants,
  keyboard commands and Android-specific background constraints.
- A04.07 now owns the four hardware-keyboard commands discovered during the source audit.
- Existing CI is a subset of the full root completion gate. It cannot be reported as a pass
  for omitted checks. The spike instrumentation opens and waits; it does not assert UI behavior.
- The fixture's old replay metrics filter `android-spike-` IDs, while the real composer uses
  random UUIDs. A00.05a adds a read-only observer for actual canonical UI admission.
- One initial artifact was written in the project checkout. Only that agent-owned file was
  moved into this branch; subsequent delegates receive an explicit worktree path.
