import { isAbsolute, join } from "node:path";

/**
 * Where an Android SDK may live, preferred first: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then
 * Android Studio's default folder on macOS (`~/Library/Android/sdk`) and on Linux
 * (`~/Android/Sdk`). Only absolute paths count. Emulator control and the doctor both read this,
 * so they agree on which SDK is installed.
 */
export function androidSdkRoots(
  env: Readonly<Record<string, string | undefined>>,
  home: string | undefined,
): string[] {
  const candidates = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    ...(home ? [join(home, "Library/Android/sdk"), join(home, "Android/Sdk")] : []),
  ];
  return [
    ...new Set(
      candidates.filter((root): root is string => Boolean(root) && isAbsolute(root ?? "")),
    ),
  ];
}
