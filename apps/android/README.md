# Android spike

Phase 0 for #561. Expo SDK 57, Hermes, stable Expo UI Compose, FlashList, the shared
`@ace/client` and the merged `@ace/design-tokens`. There is no tab bar. This is an
emulator spike, not the paired-device MVP. Release builds reject the fixture before
opening SQLite or creating a transport.

## Run

From `apps/android`, run `bun run fixture` and `bun run start` in separate terminals.
Metro uses port 8083 and the fake daemon binds only to 127.0.0.1:4345. Use a dedicated
AVD and at most one emulator. The shared Mac allows one Gradle build with four workers.

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
bun run prebuild
cd android
./gradlew :app:assembleDebug --max-workers=4 --no-daemon -PreactNativeArchitectures=arm64-v8a
```

Install the APK, reverse ports 8083 and 4345, and set the React Native dev menu's
bundle location to `localhost:8083`. The Android emulator's default 10.0.2.2:8081
is a different endpoint. Metro must bind IPv4 as well as IPv6; use
`REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 bun expo start --port 8083 --host lan`
if the localhost binding is IPv6-only on this Mac. The fixture stays loopback-only.
The native app's debug network policy permits cleartext only to literal loopback.
Release policy forbids cleartext everywhere.

A prebuild plugin binds developer support to the app's `BuildConfig.DEBUG`. Native
source is a local Expo module; generated `android/` and Gradle output are ignored.
Standard core-js array-copy polyfills load before the SDK because this Hermes build
lacks `Array.toSorted`. Client correctness has no Android-specific implementation.
Keyboard Controller owns keyboard avoidance and inherits Expo's edge-to-edge mode.
The app pins Babel 7 because the Worklets transform's TypeScript preset requires it;
resolving its broad peer range to Babel 8 fails bundling.

## Measurement

The fixture has 2,001 transcript entries and appends ten deltas each second. Open
"ace CLI phase 2". The debug "Load 2,000" control loads its bounded history in ten
pages. Scroll while the live tail streams, and collect `dumpsys gfxinfo` and PSS.
The spike SDK cap is 2,200 items; production should keep the standard 200-item tail.

Build the separate debug instrumentation APK with `:app:assembleDebugAndroidTest`
in the same bounded Gradle invocation. Install it with `adb install -t`, then run:

```sh
adb shell am instrument -w -e durationSeconds 600 \
  dev.ace.android.test/dev.ace.android.benchmark.SpikeInstrumentation
```

This ten-minute instrumentation window attributes test input injection to adb's
shell source. The product manifest gains no `INJECT_EVENTS` permission. Ordinary
app launches correctly reject injection. Open the streaming thread, load its
2,001 entries, focus the composer and press Enter or Probe. The debug-only Enter
shortcut starts the benchmark; production multiline input still inserts newlines.

The probe timestamps each of 120 native key events before Android input enqueue,
then waits for the JS draft commit and matching completed rendering frame using
FrameMetrics. It includes Android dispatch and IME processing. It excludes physical
key actuation and display scanout. Missing frames or incomplete coverage reject the
run. No zero-sample result can pass the gate. `AceSpikeInput` and `AceSpikeMetrics`
contain sample counts, timings and coverage counters, without draft contents.

`AceSpikeFont` records actual rendered glyph advances versus the bundled Inter
asset, its SHA-256, text size and foreground colour. The earlier window-callback
approach captured no key timestamps when the IME handled events and was discarded.

For restart replay, disconnect the fixture port, send, and verify the committed
SQLite record before force-stopping the app. Relaunch while still disconnected,
then restore the port and verify exactly one daemon admission and local record
cleanup. Preserve the same host/device namespace. Do not delete the database to
make a replay run pass.

Capture light and dark screenshots on two density/text-scale profiles. A Samsung-like
geometry profile on a stock Android system image is not an actual One UI runtime.
Physical Samsung, Xiaomi, OnePlus and Pixel checks remain release requirements.

See [the measurement report](../../docs/verification/android-phase0/README.md).
The gate remains pending until all measurements pass. Static
checks are scoped format/lint and `bun run typecheck` here. Run no Vitest or root
checks on the shared machine. See [ADR 0073](../../docs/adr/0073-native-mobile-clients.md).
