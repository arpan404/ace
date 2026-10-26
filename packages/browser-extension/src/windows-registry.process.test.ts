import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { windowsRegistry, type RegistryKey } from "./windows-registry.ts";

test.runIf(process.platform === "win32")(
  "native host registry round-trips Unicode and removes only its own values",
  async () => {
    const key = `Software\\Ace\\Tests\\${randomUUID()}`;
    const keys: RegistryKey[] = [
      { key, view: 32 },
      { key, view: 64 },
    ];
    const value = "C:\\Users\\owned 雪\\ace host.json";
    try {
      expect(await windowsRegistry.read(keys)).toEqual([undefined, undefined]);
      await windowsRegistry.write(keys, value);
      expect(await windowsRegistry.read(keys)).toEqual([value, value]);
      await windowsRegistry.remove(keys, "C:\\another-installation.json");
      expect(await windowsRegistry.read(keys)).toEqual([value, value]);
      await windowsRegistry.remove(keys, value);
      expect(await windowsRegistry.read(keys)).toEqual([undefined, undefined]);
    } finally {
      // Only this fixture's UUID key, never a browser's real registration.
      for (const view of [32, 64])
        await promisify(execFile)("reg.exe", ["delete", `HKCU\\${key}`, "/f", `/reg:${view}`], {
          windowsHide: true,
        }).catch(() => {});
    }
  },
);
