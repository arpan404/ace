#!/bin/sh
set -eu
# Explicit serial required. Never install into an owner's emulator implicitly.
serial=${ACE_PERF_ANDROID_SERIAL:?Set the serial of your disposable emulator}
sdk=${ANDROID_HOME:-$HOME/Library/Android/sdk}
java_home=${JAVA_HOME:-/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home}
build="$sdk/build-tools/36.0.0"
android="$sdk/platforms/android-36/android.jar"
probe_dir=$(mktemp -d /tmp/ace-device-android-probe.XXXXXX)
trap 'rm -rf "$probe_dir"' EXIT
root=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
mkdir -p "$probe_dir/classes" "$probe_dir/dex"
"$java_home/bin/javac" -classpath "$android" -d "$probe_dir/classes" "$root/tools/web-perf/device/Probe.java"
JAVA_HOME="$java_home" "$build/d8" --lib "$android" --output "$probe_dir/dex" "$probe_dir"/classes/dev/ace/perf/*.class
cat > "$probe_dir/AndroidManifest.xml" <<'MANIFEST'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.ace.perf"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/><application android:label="ace perf" android:theme="@android:style/Theme.Material.Light.NoActionBar"><activity android:name=".Probe" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>
MANIFEST
"$build/aapt" package -f -M "$probe_dir/AndroidManifest.xml" -I "$android" -F "$probe_dir/probe.apk"
(cd "$probe_dir/dex" && zip -q "$probe_dir/probe.apk" classes.dex)
"$build/zipalign" -f 4 "$probe_dir/probe.apk" "$probe_dir/aligned.apk"
"$java_home/bin/keytool" -genkeypair -keystore "$probe_dir/key.jks" -storepass aceperf -keypass aceperf -alias probe -keyalg RSA -validity 1 -dname CN=ace-perf >/dev/null 2>&1
JAVA_HOME="$java_home" "$build/apksigner" sign --ks "$probe_dir/key.jks" --ks-pass pass:aceperf --out "$probe_dir/signed.apk" "$probe_dir/aligned.apk"
"$sdk/platform-tools/adb" -s "$serial" install -r "$probe_dir/signed.apk"
"$sdk/platform-tools/adb" -s "$serial" shell am start -n dev.ace.perf/.Probe
