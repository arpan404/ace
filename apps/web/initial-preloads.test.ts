import { describe, expect, test } from "vitest";
import { windowsEntryGuard, windowsInitialChunk } from "./initial-preloads.ts";

const entry = "D:\\a\\ace\\apps\\web\\src\\main.tsx";
/** A checkout reached through a junction (or `subst S:`) resolves to the real folder. */
function realpath(path: string): string {
  const real = path
    .replace(/^S:[\\/]/i, "D:\\a\\")
    .replace(/^D:[\\/]link[\\/]/i, "D:\\a\\")
    .replaceAll("/", "\\");
  if (!/^d:\\a\\/i.test(real)) throw new Error("ENOENT");
  return real;
}

/** The chunk a module goes to under the group, as the bundler asks it. */
function chunkOf(id: string): string | null | undefined {
  const name = windowsInitialChunk(entry, realpath).name;
  return typeof name === "function" ? name(id, { getModuleInfo: () => null }) : name;
}

describe.runIf(process.platform === "win32")("the Windows page build", () => {
  test("keeps the entry in its own chunk however its path is spelled", () => {
    for (const id of [
      "D:/a/ace/apps/web/src/main.tsx",
      "d:\\a\\ace\\apps\\web\\src\\main.tsx",
      "\\\\?\\D:\\a\\ace\\apps\\web\\src\\main.tsx",
      "//?/D:/a/ace/apps/web/src/main.tsx",
      "S:/ace/apps/web/src/main.tsx",
      "D:/link/ace/apps/web/src/main.tsx",
      "D:/a/ace/apps/web/src/main.tsx?import",
      "D:/a/ace/apps/web/index.html",
    ])
      expect(chunkOf(id), id).toBeNull();
    expect(chunkOf("D:/a/ace/apps/web/src/app/app-shell.tsx")).toBe("initial");
  });

  test("fails the build when the entry lands in a shared chunk", () => {
    const guard = windowsEntryGuard(entry, realpath);
    const run = (modules: string[], isEntry: boolean) => {
      const errors: string[] = [];
      const bundle = {
        "assets/x.js": {
          type: "chunk",
          isEntry,
          fileName: "assets/x.js",
          modules: Object.fromEntries(modules.map((id) => [id, {}])),
        },
      };
      const hook = guard.generateBundle;
      const handler = typeof hook === "function" ? hook : hook?.handler;
      handler?.call(
        {
          error: (message: string) => {
            errors.push(message);
            throw new Error(message);
          },
        } as never,
        {} as never,
        bundle as never,
        false,
      );
      return errors;
    };
    expect(() => run(["S:/ace/apps/web/src/main.tsx", "D:/a/x.ts"], false)).toThrow(
      /shared chunk assets\/x\.js/,
    );
    expect(run(["D:/a/ace/apps/web/src/main.tsx"], true)).toEqual([]);
    expect(run(["D:/a/ace/apps/web/src/app/app-shell.tsx"], false)).toEqual([]);
  });
});
