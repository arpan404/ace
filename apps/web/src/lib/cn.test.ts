import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCn as configuredCn } from "cn/config";
import { expect, test } from "vitest";
import { cn } from "./cn.ts";
import { cnExtension } from "./cn-extension.ts";

test("the app's font sizes and text colours both survive a merge", () => {
  expect(cn("text-ui text-muted-foreground", "text-primary-foreground").split(" ")).toEqual([
    "text-ui",
    "text-primary-foreground",
  ]);
  expect(cn("text-ui", "text-md")).toBe("text-md");
  expect(cn("text-prose text-foreground", "text-2xs")).toBe("text-foreground text-2xs");
});

/** Every class list the app writes in a `className` or a `cn(...)` call. */
function appClassLists(): string[] {
  const root = join(import.meta.dirname, "..");
  const lists = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".gen.ts"))
        for (const match of readFileSync(path, "utf8").matchAll(/"([a-z0-9!:[\]()/.#%_ -]+)"/g)) {
          const value = match[1]?.trim();
          if (value && /(^|\s)-?[a-z]+(-[a-z0-9[\]/.#%]+)+/.test(value)) lists.add(value);
        }
    }
  };
  walk(root);
  return [...lists];
}

test("the precompiled merger resolves the app's classes exactly as the configured one does", () => {
  const reference = configuredCn(cnExtension);
  const lists = appClassLists();
  expect(lists.length).toBeGreaterThan(500);
  for (let index = 0; index < lists.length; index++) {
    const base = lists[index] ?? "";
    const override = lists[(index * 7 + 3) % lists.length] ?? "";
    expect(cn(base, override)).toBe(reference(base, override));
    expect(cn(override, base)).toBe(reference(override, base));
  }
});
