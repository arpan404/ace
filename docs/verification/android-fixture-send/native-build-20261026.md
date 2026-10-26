# Android native build verification, 2026-10-26

Native compile gate passed for the debug app and instrumentation APKs. This record
does not establish a device, fixture-send UI, bundler runtime, performance, CI, or
full repository check pass. No emulator, device, install, or instrumentation run occurred.

## Source and execution scope

Base HEAD: `b92d9d2618481dfd8c77a94c6bcab5a26fa61395`, with its HEAD reflog entry
dated 2026-10-26 08:56:35 -0500, before this verification. The build used dirty
sources, not a clean checkout of that commit. Preexisting changes included
`apps/android/benchmark/SpikeInstrumentation.kt`, `apps/android/package.json`,
`apps/android/plugins/with-ace-probe.ts`, fixture scripts, `bun.lock`, and
`packages/provider-kit/src/process.ts`. `FixtureSendScenario.kt` and
`FixtureDevServer.kt` were untracked source files. Documentation and workflow
changes were also present; local before/after status captures preserve the inventory.

The native driver ran 17:58:59–18:05:14 UTC, taking 375.12 seconds. The complete
session through final audit took 561.84 seconds, below the 15-minute bound.
One Gradle executor ran at a time, with four workers, `--no-daemon`, and arm64-v8a
only. Each subprocess had its own session/process group and timeout. There were
no retries, delegates, source/configuration fixes, commits, or manual downloads.

## Toolchain and commands

Java 24.0.2 was selected using `/usr/libexec/java_home -v24`. Gradle was 9.3.1,
AGP 8.12.0, Kotlin 2.1.20, SDK/target SDK 36, build-tools 36.0.0, and NDK
27.1.12297006. Bun was 1.4.3 and Node was v26.7.0.

The following reconstructs the recorded argv/cwd with command-scoped environment.
`JAVA_TOOL_OPTIONS` was initially unset and remained unset outside the subprocesses.
The flag reached child prefab JVMs; no persistent Gradle configuration was edited.

```sh
worktree=/Users/lucifer/.ace/worktrees/f2dce02269b987e790dd7cc242d0f7dbed17ffb46cbef6cf8b59d3fa3f520c98
build_env=(env
  JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-24.jdk/Contents/Home
  ANDROID_HOME=/Users/lucifer/Library/Android/sdk
  ANDROID_SDK_ROOT=/Users/lucifer/Library/Android/sdk
  JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED
  CI=1 EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1
  PATH="/Library/Java/JavaVirtualMachines/jdk-24.jdk/Contents/Home/bin:/Users/lucifer/Library/Android/sdk/platform-tools:$PATH"
)
cd "$worktree/apps/android/android"
"${build_env[@]}" ./gradlew \
  ':react-native-screens:configureCMakeDebug[arm64-v8a]' \
  ':react-native-worklets:configureCMakeDebug[arm64-v8a]' \
  --max-workers=4 --no-daemon -PreactNativeArchitectures=arm64-v8a --stacktrace --console=plain
cd "$worktree/apps/android"
"${build_env[@]}" bun run prebuild --no-install
# package script expands to: expo prebuild --platform android --no-install
cd "$worktree/apps/android/android"
"${build_env[@]}" ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest \
  --max-workers=4 --no-daemon -PreactNativeArchitectures=arm64-v8a --stacktrace --console=plain
```

| Phase                                | Exit |  Elapsed |  Timeout |
| ------------------------------------ | ---: | -------: | -------: |
| Both targeted prefab/CMake tasks     |    0 | 173.33 s |    240 s |
| Prebuild, once                       |    0 |   0.87 s |     60 s |
| Debug app + instrumentation assembly |    0 | 198.70 s | 576.65 s |

Both requested CMake tasks executed successfully. Neither Gradle log contained
the prior JNA/native-access warning. SDK XML compatibility and dependency
deprecation warnings remained. Assembly also passed screens/worklets CMake.

## APK artifacts

Paths are local build outputs, not committed artifacts.

- App: `/Users/lucifer/.ace/worktrees/f2dce02269b987e790dd7cc242d0f7dbed17ffb46cbef6cf8b59d3fa3f520c98/apps/android/android/app/build/outputs/apk/debug/app-debug.apk`
  - Size: 81,387,448 bytes; native libraries: arm64-v8a only.
  - SHA-256: `8eaf90fa13821ec2076d5ea005aa167b7ac20006e0f0610db34d15ac5d7d73fe`
- Instrumentation: `/Users/lucifer/.ace/worktrees/f2dce02269b987e790dd7cc242d0f7dbed17ffb46cbef6cf8b59d3fa3f520c98/apps/android/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`
  - Size: 19,324 bytes; no native libraries.
  - SHA-256: `18d17a10de85428adf4eb600f3a5f550321a5d24347b10ed94fcb98ad3908b8b`

Prebuild copied `apps/android/benchmark/` sources into generated
`android/app/src/androidTest/java/dev/ace/android/benchmark/`. Each source and
its generated copy had the same SHA-256:

| Kotlin source             | Source and copy SHA-256                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `SpikeInstrumentation.kt` | `6e119f666d009d378cc7ad3f9da8d6f7adf622e4bd5734b743ea7a9b65993d54` |
| `FixtureSendScenario.kt`  | `4d930245befc5872340095561e0313a32d07b9a834e1d7ebc9c19bbd05449ac8` |
| `FixtureDevServer.kt`     | `c0d5def7a2d2375e24c04ce8d3661424578b7cf7d4a5167e2b6c31a79c149b86` |

## Integrity, cleanup, and remaining gates

Tracked manifest/package/app.json/lock hashes stayed unchanged. The full tracked
diff was unchanged immediately after prebuild, then changed during assembly while
other agents were active. The aggregate diff hash cannot identify those changes.
No SDK package was added or changed, no SDK auto-install appeared in the log, and
no SDK/JDK upgrade was performed. Initial free space was 55.65 GiB, above the
10 GiB prerequisite; the final 18:06:20 UTC audit recorded 49,058,942,976 bytes,
45.69 GiB, available on the Data volume. Initial and final checks found no active
Gradle/emulator process. No owned process-group members remained at final audit.

The later root `bun run check` result is parent-reported, separate from these
native logs: `fmt:check` passed, then `docs:protocol --check` failed on a stale
protocol manifest. That invocation did not run its later gates: `lint`,
`check:size`, `check:annotate`, `check:extension`, `check:ui`, `check:deps`,
`typecheck`, `test`, or `check:perf`. This verification did not run
`typecheck:full` or CI. Full-check and CI remain unpassed; UI, real fixture-send,
runtime/bundler, and performance gates remain unverified by this build.

## Local raw evidence

These machine-local `/tmp` links may expire. The curated results above are the
durable evidence summary; APKs and raw/binary logs are not included in this record.

- [Raw structured report](/tmp/ace-android-native-verify-20261026-125851/report.json)
- [Original curated audit](/tmp/ace-android-native-verify-20261026-125851/verification.md)
- [Targeted CMake log](/tmp/ace-android-native-verify-20261026-125851/target-configure.log)
- [Prebuild log](/tmp/ace-android-native-verify-20261026-125851/prebuild.log)
- [Assembly log](/tmp/ace-android-native-verify-20261026-125851/assemble.log)
- [Source status before](/tmp/ace-android-native-verify-20261026-125851/git-status-before.txt)
- [Source status after](/tmp/ace-android-native-verify-20261026-125851/git-status-after.txt)
