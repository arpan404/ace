# A01.01 execution boundary: implementation and open gates

Reference: [measurement variant proposal](../../mobile/android-measurement-variant.md),
[A01.01 plan](../../plans/android-ios-parity.md#m01-prove-the-foundation-can-support-the-full-app).
Commits: `09e49e018` (JS/config), `fb8f01b95` (native). Branch: `ace/android-ios-parity`.

## Implemented (source level)

- Native-reported execution mode (`debug-fixture`, `measurement-fixture`, `production`)
  via library `BuildConfig.ACE_EXECUTION_MODE` and a synchronous `AceNative.getExecutionMode`
  function, read in JS through a fail-closed Zod parser (`apps/android/src/execution-mode.ts`,
  `src/native-mode.ts`).
- App startup rejects production before the fixture runtime; the fixture runtime verifies
  the bundle matches its build type; composer probe, metrics, and input wrappers refuse
  production calls while teardown stays crash-free.
- `measurement` build type (release-like via `initWith release`, `.measurement` suffix,
  profileable, `matchingFallbacks = ["release"]`); release explicitly `profileable false`.
- Release bundle entry pinned to `index.production.tsx` (fail-closed unpaired shell, no
  fixture/replay/metrics imports); unexpected `createBundle*JsAndAssets` tasks fail the build.
- Input probe/metrics moved to an `instrumented` source set (debug + measurement only);
  release registers no hooks. Probe policy is the explicit execution mode, not DEBUGGABLE.
- Measurement network overlay equals the debug loopback policy; main stays locked down.

## Validation run

- `bun run test -- apps/android/src/execution-mode.test.ts apps/android/src/variant.test.ts`:
  2 files, 14 tests, all pass.
- `bun run typecheck` (cwd `apps/android`): exit 0.
- `bunx oxlint --deny-warnings` on touched JS/TS: exit 0, no findings. `oxfmt`: clean.
- `bun run prebuild`: exit 0. Generated `android/app/build.gradle` contains the measurement
  block, release `profileable false`, and the production entry pin; generated
  `android/app/src/measurement/res/xml/ace_network_security.xml` is byte-identical to debug.
- Commits carry the user's identity (`Luseefor <sapanakosansar18@gmail.com>`) with no
  trailers, verified via `git log --format=full` and `git log --format='%(trailers)'`.

## Explicitly not run (open gates, not passes)

- Gradle `assembleMeasurement` / `assembleRelease`: needs coordination with the active
  Gradle/device owner; not attempted. Native compile of the new source sets is unproven.
- Measurement Probe positive and production negative on a device: no emulator was booted
  (`adb devices` empty; screens/devices groups disabled); shared `Ace_Android`/`Ace_Tablet`
  use needs coordination. No device state was created, replaced, or erased.
- Artifact verifier (proposal task 9) and full `bun run check`: unrun. No push (parent owns push).
