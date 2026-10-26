import { expect, test } from "vitest";
import { windowsInitialChunk } from "./initial-preloads.ts";

/** The chunk a module goes to under the group, as the bundler asks it. */
function chunkOf(entry: string, id: string): string | null | undefined {
  const name = windowsInitialChunk(entry).name;
  return typeof name === "function" ? name(id, { getModuleInfo: () => null }) : name;
}

test("on Windows the entry keeps its own chunk whatever slashes or drive case its id uses", () => {
  const entry = "D:\\a\\ace\\apps\\web\\src\\main.tsx";
  expect(chunkOf(entry, "D:/a/ace/apps/web/src/main.tsx")).toBeNull();
  expect(chunkOf(entry, "d:\\a\\ace\\apps\\web\\src\\main.tsx")).toBeNull();
  expect(chunkOf(entry, "D:/a/ace/apps/web/index.html")).toBeNull();
  expect(chunkOf(entry, "D:/a/ace/apps/web/src/app/app-shell.tsx")).toBe("initial");
});
