import { join } from "node:path";
import { findExecutable } from "@ace/provider-kit/discovery";
import { androidSdkRoots } from "./sdk-roots.ts";

/** The Android tools ace runs, by absolute path. */
export type AndroidTools = {
  /** From an Android SDK's platform-tools, else the `adb` on PATH (a distribution's package). */
  adb?: string | undefined;
  /** The Android Emulator, from an Android SDK. */
  emulator?: string | undefined;
};

/**
 * Where ace finds adb and the emulator. An SDK holding both wins, so they come from one install;
 * otherwise the emulator comes from the first SDK that has it, and adb from the first SDK that
 * has it or else from PATH, as distributions install it (`/usr/bin/adb`). Phones and network
 * devices need only adb. The devices service and `ace doctor` both read this, so they agree.
 */
export async function findAndroidTools(input: {
  env: Readonly<Record<string, string | undefined>>;
  home: string | undefined;
  /** An executable's absolute path, given a path or a name to look up on PATH. */
  find?: (nameOrPath: string) => Promise<string | undefined>;
}): Promise<AndroidTools> {
  const find = input.find ?? ((nameOrPath: string) => findExecutable(nameOrPath, { ...input.env }));
  const roots = await Promise.all(
    androidSdkRoots(input.env, input.home).map(async (root) => {
      const [adb, emulator] = await Promise.all([
        find(join(root, "platform-tools", "adb")),
        find(join(root, "emulator", "emulator")),
      ]);
      return { adb, emulator };
    }),
  );
  const paired = roots.find((root) => root.adb && root.emulator);
  if (paired) return paired;
  const emulator = roots.find((root) => root.emulator)?.emulator;
  const adb = roots.find((root) => root.adb)?.adb ?? (await find("adb"));
  return { adb, emulator };
}
