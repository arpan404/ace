# Android fixture-send verification (A00.05c)

Bounded host driver `apps/android/scripts/fixture-send.ts` (+ owned-process
helper `apps/android/scripts/fixture-send-process.ts`) for one real functional
send on an explicit device. Sources are implemented and native compile passes
(both APKs per `/tmp/ace-android-native-verify-20261026-125851/report.json`);
no native device pass has been recorded — nothing below is a native UI pass claim.

## What it drives

- Existing `SpikeInstrumentation -e scenario fixture-send -e probeText <probe>`
  from `apps/android/benchmark/`, which opens `stream-thread`
  ("ace CLI phase 2"), types `<probe>` into the real composer
  (`accessibilityLabel="Message"`), taps send (`↑`) once, and asserts the
  composer cleared. Bundle carries lengths/counts only, never message text.
- Existing observer `GET http://127.0.0.1:4345/admissions?threadId=stream-thread&probe=...`
  (`apps/android/scripts/fixture-admissions.ts`), returning
  `{commandIds:string[]}`. Responses are parsed with a Zod schema
  (`{ commandIds: CommandId[] }`); no unchecked casts.

## CLI

```sh
# cwd: apps/android
node scripts/fixture-send.ts --serial <adb-serial> \
  --app-apk <path-to-app-debug.apk> --test-apk <path-to-app-debug-androidTest.apk> \
  --probe <nonce> [--negative-probe <other-nonce>] \
  [--overall-timeout-ms 180000]
```

Probes must match `[A-Za-z0-9._~-]{1,200}` (subset of the device scenario's
printable-ASCII bound), e.g. `--probe fs-1761600000-a1b2c3`. The constrained
charset means the `adb shell am instrument … -e probeText <P>` argument vector
needs no remote-shell quoting: no metacharacter can appear.

## Assertions contract

- Positive: P zero-before, instrument bundle `scenario=fixture-send`,
  `fixtureSend=passed`, `sendClicks=1`, `probeLength=len(P)`,
  `INSTRUMENTATION_CODE: -1` (Activity.RESULT_OK), then P exactly-one-after.
  adb exit 0 alone never passes. Prints `fixture-send: PASS …`, exits `0`.
- `2` prerequisite (before instrumentation): bad flags, missing APK,
  unknown/offline device, Metro not already running, fixture host
  unreachable, reverse `--list` failure or remote-conflict, install failure,
  op timeout/deadline before instrumentation. A reachable fixture answering
  malformed JSON is instead a verification-side schema rejection (`1`).
  P-nonzero-before stays `1`.
- `1` verification (instrumentation onward): P/N nonzero-before, instrument
  bundle mismatch/cancelled, P not exactly once, timeout/deadline/signal
  during verification.
- Negative control `--negative-probe N`: verifies the real send first — P
  zero-before (and N zero-before), instrument bundle, P exactly-one-after —
  then applies the SAME exactly-one assertion to N:
  - P=1, N=0 → prints `NEGATIVE_CONTROL_OK`, exits `1` (expected negative;
    the marker, not the code alone, distinguishes it from a real failure).
  - P=1, N=1 → exits `0` ("unexpected negative green") so CI fails a
    non-discriminating observer instead of silently passing.
  - Any UI/transport failure (P≠1, instrument reject) exits `1` WITHOUT the
    marker and must never be read as an expected negative.

## Safety bounds

- Every device command uses `adb -s <serial>`; unknown/offline/unauthorized
  serial refuses. No `uninstall`, `clear`, `wipe`, `emu kill`, `boot`,
  `reboot`, `kill-server`, Gradle, or SDK action exists in the driver.
- `install -r` / `install -t -r` only (data-preserving reinstall).
- Hard overall watchdog (default 180 s, never above): aborts owned fetches,
  SIGTERMs owned process groups, SIGKILLs stragglers after 2 s, awaits the
  single close promise per child. Each child leads its own POSIX group
  (`detached`), so grandchildren holding pipes die with it; only negative
  PIDs of owned leaders are ever signalled. Per-op budgets: installs ≤90 s,
  instrumentation ≤120 s, observe poll ≤30 s, plumbing ≤10 s. Stream output
  capped at 256 KiB per stream in wire bytes (flagged); HTTP bodies stream
  through a reader that cancels past 256 KiB wire bytes. Signals abort owned
  work; the process sets
  `exitCode` only after cleanup finishes — `process.exit` never runs inside
  `try`/`catch`.
- `adb reverse --list` is parsed in its real three-field form
  (`<transport> <remote> <local>`; transport is a bus tag, never the serial —
  `-s <serial>` already scopes output). Creation uses `--no-rebind`; on an
  "already exists" race the list is re-read and reused only if exactly equal.
  A pre-existing identical mapping is reused and never removed; a remote
  bound to a different local is a conflict → exit `2`. Only mappings this
  run added are `--remove`d. Nothing foreign is killed or unmapped.
- Reuse of `@ace/provider-kit/process` was evaluated and declined: its probe
  path pulls the koffi native dep plus worker-thread machinery and would
  need an `apps/android` manifest amendment (reported to parent, not made).
  The helper mirrors its group-ownership pattern dependency-free; no package
  internals are imported, and app `src` never imports provider-kit.
- Driver never starts Metro, fixture, emulators, or builds. It requires them
  already running and fails `2` otherwise. It never kills other processes.

## Prerequisites (unresolved until a real device run)

1. `Ace_Android` (or other registered AVD) already booted outside this driver;
   serial passed explicitly. No reservation is held by this task.
2. `bun run fixture` already serving `127.0.0.1:4345` and `bun run start`
   (Metro 8083) already `packager-status:running`. Driver checks both and
   refuses to launch either; safe-ownership/health contract stays manual.
3. Prebuilt debug + `assembleDebugAndroidTest` APK paths passed explicitly.
   No build ran in this task.
4. Bundler endpoint (critical, verified read-only): emulator default
   `10.0.2.2:8081` is not Metro `8083`. `apps/android/README.md` requires
   `adb reverse tcp:8083 tcp:8083` plus RN dev-menu bundle location
   `localhost:8083` (and `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 ... --host lan`
   if localhost binds IPv6-only). Debug network policy
   (`plugins/with-ace-network.ts`, `MainApplication.kt` with
   `useDevSupport = BuildConfig.DEBUG`) permits cleartext only to literal
   loopback `127.0.0.1`/`localhost`/`::1`; fixture `ws://127.0.0.1:4345`
   (`src/runtime.ts`) complies. Bundler gap closed in source only: A00.05d test
   helper `benchmark/FixtureDevServer.kt` sets ordinary RN `debug_http_host` to
   `localhost:8083` then restores it (source-verified). Native compile is verified
   (target configure exit 0 / 173.33 s, assemble exit 0 / 198.70 s, both APKs per
   `/tmp/ace-android-native-verify-20261026-125851/report.json`); native runtime
   is not. Until an attested device run is recorded, do not claim the bundler path
   is configured end to end.

## Evidence (host-driver boundary only — not a native UI pass)

- Native compile (verified, not a UI pass): target configure exit 0 (173.33 s),
  prebuild exit 0 (0.87 s), assembleDebug + assembleDebugAndroidTest exit 0
  (198.70 s), both APKs;
  `/tmp/ace-android-native-verify-20261026-125851/report.json`. Durable detail is
  being written by another owner at
  [native-build-20261026.md](native-build-20261026.md). Scoped
  `JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED` fixed the JDK 24 prefab
  path; no SDK changes/orphans; no UI/perf claim.
- Fake-adb boundary rerun `/tmp/a00verify/logs/verify-a00-05c-rerun.log`: ALL 12
  cases pass (incl. 4.3 s timeout, reverse ownership, strong negative). Driver
  plumbing only; no device booted, no real instrumentation run.
- Positive (real device): intended `stdout` tail, `INSTRUMENTATION_CODE: -1` block,
  before `{"commandIds":[]}` and after `{"commandIds":["<one-id>"]}` (ID
  redacted to count in notes), `adb devices -l` serial line. Not recorded.
- Negative (real device): `--negative-probe` run proving P=1 then printing
  `NEGATIVE_CONTROL_OK` with N=0, exiting `1`. Not recorded.

Local static scope only: format/lint/typecheck. CI lane (336-line
`android-lane.yml`, A00.06) is static only, never run. Native compile verified
(both APKs, report above); JNA path fixed via scoped `JAVA_TOOL_OPTIONS`.
Full `bun run check` actually ran and stopped early
(`/tmp/ace-android-integration-check-20261026.log`): `fmt:check` passed on 10,029
files, then `docs:protocol --check` failed on a stale `manifest.json`; later
gates unrun with a root-cause audit ongoing. No device, server, instrumentation,
or network run happened in this implementation task. Native/physical gates open.
