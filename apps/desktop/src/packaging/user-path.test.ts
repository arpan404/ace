import { expect, test } from "vitest";
import {
  addToUserPath,
  removeFromUserPath,
  userPathRegistry,
  type UserPath,
  type UserPathRegistry,
} from "./user-path.ts";

const env = { USERPROFILE: "C:\\Users\\Ada" };

function memoryRegistry(
  initial: UserPath,
): UserPathRegistry & { current: UserPath; writes: number } {
  const registry = {
    current: initial,
    writes: 0,
    read: async () => registry.current,
    write: async (path: UserPath) => {
      registry.current = path;
      registry.writes += 1;
    },
  };
  return registry;
}

test("adding the ace folder keeps the person's entries and the value's registry type", async () => {
  const registry = memoryRegistry({
    value: "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;",
    kind: "ExpandString",
  });
  expect(await addToUserPath(registry, "C:\\Users\\Ada\\.ace\\bin", env)).toBe(true);
  expect(registry.current).toEqual({
    value: "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\Ada\\.ace\\bin",
    kind: "ExpandString",
  });
});

test("a folder already on the user PATH, in any spelling, is not added twice", async () => {
  const registry = memoryRegistry({
    value: "C:\\Tools;%userprofile%\\.ACE\\bin\\",
    kind: "String",
  });
  expect(await addToUserPath(registry, "C:\\Users\\Ada\\.ace\\bin", env)).toBe(false);
  expect(registry.writes).toBe(0);
});

test("a person without a user PATH gets an expandable one holding only ace's folder", async () => {
  const registry = memoryRegistry({ value: "", kind: "ExpandString" });
  await addToUserPath(registry, "C:\\Users\\Ada\\.ace\\bin", env);
  expect(registry.current).toEqual({ value: "C:\\Users\\Ada\\.ace\\bin", kind: "ExpandString" });
});

test("removing takes out only ace's folder", async () => {
  const registry = memoryRegistry({
    value: "C:\\Tools;C:\\Users\\Ada\\.ace\\bin;%USERPROFILE%\\go\\bin",
    kind: "ExpandString",
  });
  expect(await removeFromUserPath(registry, "c:\\users\\ada\\.ace\\bin\\", env)).toBe(true);
  expect(registry.current).toEqual({
    value: "C:\\Tools;%USERPROFILE%\\go\\bin",
    kind: "ExpandString",
  });
  expect(await removeFromUserPath(registry, "C:\\Users\\Ada\\.ace\\bin", env)).toBe(false);
});

test("a folder that would split into several PATH entries is refused", async () => {
  const registry = memoryRegistry({ value: "C:\\Tools", kind: "String" });
  await expect(addToUserPath(registry, "C:\\a;C:\\b", env)).rejects.toThrow("Unsupported");
  expect(registry.writes).toBe(0);
});

test.runIf(process.platform === "win32")(
  "the real user PATH round-trips a Unicode folder and keeps its type",
  async () => {
    const before = await userPathRegistry.read();
    const folder = `${process.env.TEMP ?? "C:\\Temp"}\\ace päth ${process.pid}`;
    try {
      expect(await addToUserPath(userPathRegistry, folder, process.env)).toBe(true);
      const added = await userPathRegistry.read();
      expect(added.kind).toBe(before.value === "" ? "ExpandString" : before.kind);
      expect(added.value.split(";")).toContain(folder);
      expect(await removeFromUserPath(userPathRegistry, folder, process.env)).toBe(true);
      expect((await userPathRegistry.read()).value).toBe(before.value.replace(/;+$/, ""));
    } finally {
      const now = await userPathRegistry.read();
      if (now.value !== before.value) await userPathRegistry.write(before);
    }
  },
);
