# Android measurement variant proposal

Status: **A01.01 boundary implemented at source level** (`09e49e018`, `fb8f01b95`;
evidence [a01-01-boundary.md](../verification/android-measurement-variant/a01-01-boundary.md)).
Unit tests, typecheck, lint, format, and prebuild pass. Gradle assemble, device
positive/negative runs, the artifact verifier (task 9 below), and the full
`bun run check` gate remain open. No M00/M01 completion is claimed.

Plan: [M01 foundation](../plans/android-ios-parity.md#m01-prove-the-foundation-can-support-the-full-app).
Track state in the [execution ledger](../plans/android-ios-parity-progress.md);
follow the [validation lane](android-validation-lane.md) and
[mobile architecture](../adr/0073-native-mobile-clients.md). The status above
includes the latest debug compile result; older first-build failure notes are
historical, not an outstanding compile prerequisite for this proposal.

## Current source and installed toolchain evidence

- The [local library](../../apps/android/modules/ace-native/android/build.gradle)
  owns namespace/build configuration separately from the app. App BuildConfig
  is unavailable directly to JS and must not be imported into the library.
- Installed RN 0.86.3 Gradle plugin `gradle/libs.versions.toml:2` pins AGP 8.12.0.
  Read-only inspection of its cached gradle-api JAR confirms ApplicationBuildType
  has `isProfileable()/setProfileable(boolean)`: `profileable true` is valid here.
  AGP ProcessApplicationManifest$CreationAction passes it to the manifest task.
  Final owner is merged application `<profileable android:shell="true"/>`;
  installed SDK 36 `data/res/values/attrs_manifest.xml:4128-4135` defines the flag.
- [Composer](../../apps/android/src/Composer.tsx) lines 51, 70, 105, 128-129, 154
  gate metrics, focus, submit action and Probe on `__DEV__`; lines 27-30 clean up
  unconditionally. Release JS requires an explicit measurement policy instead.
- [App](../../apps/android/src/App.tsx) lines 10, 119 owns the runtime import/call.
  [Runtime](../../apps/android/src/runtime.ts) lines 6, 14-16, 29, 41 imports replay
  and opens the fixture. A runtime union/BuildConfig check proves no exclusion.
- Native [AceNativeModule](../../apps/android/modules/ace-native/android/src/main/java/dev/ace/nativeui/AceNativeModule.kt)
  lines 10-25 registers all hooks; [InputProbe](../../apps/android/modules/ace-native/android/src/main/java/dev/ace/nativeui/InputProbe.kt)
  lines 19-21 requires DEBUGGABLE.
- Installed RN Gradle plugin paths: `ReactExtension.kt:100-106` excludes listed
  debuggable variants from bundling; `TaskConfiguration.kt:65-90` bundles others
  with devEnabled=false; `tasks/BundleHermesCTask.kt:56` exposes entryFile.
  These Kotlin paths are under its `react-native-gradle-plugin/src/main/kotlin/com/facebook/react/`.

## Proposed contract and boundaries

- Build types: existing debug unchanged; explicit `measurement` opt-in; release
  is production. Measurement inherits release, is nondebuggable/profileable,
  uses bundled optimized Hermes JS, and has applicationIdSuffix `.measurement`.
  Keep minification/resource shrinking aligned with current release defaults.
- Production forbids fixture transport, replay routes, and input-injection hooks.
  Measurement explicitly permits this app's bounded 120-key probe and loopback
  fixture. Profileable status grants no input-injection permission. Preserve
  focus, single-run, count, and coverage checks; never add INJECT_EVENTS permission.
- Library-owned BuildConfig String `ACE_EXECUTION_MODE` has exact values
  `debug-fixture`, `measurement-fixture`, `production`; enable its buildConfig
  generation. Configure matching library measurement build type, with release
  fallback for other dependencies. Never import app BuildConfig into the library.
- Common AceNative exposes synchronous Expo `Function("getExecutionMode")`.
  Public TS owner `modules/ace-native/index.tsx` reads its result as unknown and
  Zod-parses the three-value enum before returning exported `ExecutionMode`.
  Missing module, unknown value, or JS/native mismatch fails closed before I/O.
  No ambient globals, reflection, unchecked assertions, or environment mode override.
  Proposed public bridge shape for that index.tsx, with Expo and Zod imports:
  ```ts
  const native = requireNativeModule<{ getExecutionMode(): unknown }>("AceNative");
  const Mode = z.enum(["debug-fixture", "measurement-fixture", "production"]);
  export type ExecutionMode = z.infer<typeof Mode>;
  export function getExecutionMode(): ExecutionMode {
    return Mode.parse(native.getExecutionMode());
  }
  ```
- The bridge reports identity; it does not establish compile-time exclusion.
  Separate JS entry dependency graphs and native source sets establish exclusion.
- Production gets an explicit unavailable/unpaired startup shell until M02 exists.
  Do not invent pairing or silently fall back to fixture startup to make Release open.
  This is an A01.01 exclusion artifact, not a production-parity completion claim.

## Ordered implementation tasks, at most three writable paths each

All task paths are relative to `apps/android/` from the repository root;
module/JS paths in the proposed contract use the same base.
N = `modules/ace-native/android/src`; K = `java/dev/ace/nativeui`; substitute both
prefixes in task paths. All tasks below are unimplemented. Serialize overlapping
tasks; integrate the whole split before claiming it builds. Moves count both paths.

1. App variant/entry owner, 3 paths: `plugins/with-ace-variant.ts` new,
   `app.json`, `index.production.tsx` new.
   Plugin adds measurement; release explicitly sets profileable=false. In generated Gradle,
   configure RN BundleHermesCTask entryFile by exact variant task: measurement
   uses existing index.ts; release uses index.production.tsx. Use configureEach
   on the installed task type, reject unexpected nondebug bundle task names, and
   do not rely on one global ENTRY_FILE/env setting or add measurement to
   debuggableVariants. Production entry registers only the fail-closed shell
   and validated mode bridge, preserving required entry polyfills. No App/runtime
   or input-metrics import in its dependency graph. Never hand-edit android/.

2. Library boundary/bridge owner, 3 paths: `modules/ace-native/android/build.gradle`,
   `N/main/K/AceNativeModule.kt`, `modules/ace-native/index.tsx`.
   Configure library modes and source sets. Common module retains theme and
   getExecutionMode, calls `installInputHooks(builder, appContext)`, and no longer
   constructs InputProbe/InputMetrics itself. Use explicit ModuleDefinitionBuilder
   and AppContext parameters. Debug + measurement include N/instrumented/K;
   release includes N/release/K only. No release fallback to instrumented hooks.

3. Hook implementations, 2 paths: `N/instrumented/K/InputHooks.kt` new and
   `N/release/K/InputHooks.kt` new. Same typed installInputHooks signature;
   instrumented implementation owns metrics/probe registration and teardown;
   release implementation registers none. No production reference to those classes.

4. Metrics relocation, 2 paths: move `N/main/K/InputMetrics.kt` to
   `N/instrumented/K/InputMetrics.kt`; preserve behavior. Count both paths as writes.

5. Probe relocation/policy, 2 paths: move `N/main/K/InputProbe.kt` to
   `N/instrumented/K/InputProbe.kt`. Replace DEBUGGABLE-only authorization with
   the library's explicit debug/measurement policy, preserving all other guards.
   Production excludes the class; an if around registration alone is insufficient.

6. JS runtime/bridge consumers, 3 paths: `src/App.tsx`, `src/runtime.ts`,
   `src/input-metrics.ts`. App obtains validated ExecutionMode; rejects production
   before fixtureRuntime(mode). Runtime accepts only debug/measurement modes and
   uses `fixtureRuntime(mode: Exclude<ExecutionMode, "production">): Promise<Runtime>`;
   verifies `__DEV__` is true/false respectively before SQLite or transport startup.
   Input wrappers validate native results and refuse calls outside instrumented
   modes before looking up absent hooks; no eager binding to missing native methods.
   Existing replay import remains reachable only from the nonproduction entry graph.

7. Measurement UI, 1 path: `src/Composer.tsx`. Use the public validated mode for
   Probe visibility, measure(), focus attachment, commit metrics, and teardown;
   production uses safe disabled behavior. Measurement must work with `__DEV__` false.
   Keep ordinary measurement submit/newline behavior intentional; Probe button
   is the positive entry. Do not broadly enable Thread/sheets debug controls.

8. Variant network policy, 1 path: `plugins/with-ace-network.ts`. Add measurement
   overlay permitting literal loopback only, equivalent to debug. Main/release
   keep cleartext denied. Variant plugin owns profileable through AGP, not this file.

9. Artifact verification, 1 path: `scripts/verify-variant-artifacts.ts` new.
   Inspect explicit APK/bundle-map/merged-manifest/DEX inputs without a device;
   nonzero on absent, stale, malformed, mismatched, or uninspectable artifacts.

## Deferred acceptance

- Coordinate with the active Gradle/device owner before any future build.
  Use one ABI, --max-workers=4 --no-daemon, one serialized build/device job;
  do not replace the installed shared debug app or erase data. No temporary AVDs.
- Positive: assembleMeasurement bundles JS with `__DEV__` false and no dev server;
  verify nondebuggable + profileable shell flag and validated measurement mode.
  Use existing fixture, reverse 4345, focus an empty composer, tap Probe once;
  require 120 attempts, >=114 completed samples, and AceSpikeInputFinal evidence.
  Existing SpikeInstrumentation rejects nondebuggable apps; do not use that debug
  runner as the measurement positive or relax it incidentally. Platform injection
  failures must be reported, not treated as passing coverage. No p95 claim yet.
- Deterministic production negative: assembleRelease must use production entry
  even with ENTRY_FILE set to fixture index or measurement task built beforehand;
  either reject the override or pin the release task input. Record artifact hashes.
  Inspect emitted bundle dependency map: runtime.ts, replay-probe.ts, input-metrics.ts
  absent; inspect all APK DEX files: InputProbe/InputMetrics/instrumented hook
  registrations absent. Missing maps/disassembly fail, not skip. Verify a poisoned
  positive artifact substituted for release is rejected by the same verifier.
- Inspect merged release manifest: nondebuggable, no shell-profileable opt-in,
  cleartext denied, no INJECT_EVENTS. Inspect measurement overlay separately.
  A false BuildConfig value, hidden button, string grep alone, rejected bridge call,
  or short interval with no observed traffic cannot substitute for exclusion proof.
- Later release smoke: unavailable/unpaired shell; ace://spike URLs cannot invoke
  replay; no fixture connection attempted. Pair this with artifact proof above.
  Static/type checks and full integration gate follow repo policy after integration.
  Measurement/production variant builds, merged outputs, device positives/negatives
  remain unrun. Current debug APK compilation does not satisfy these gates.
