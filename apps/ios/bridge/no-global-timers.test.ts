import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

/*
 * The bridge runs in JavaScriptCore on the phone. The host's web platform shim (`@ace/native-host`)
 * gives it setTimeout and performance, but the bridge and the shared client code it runs take their
 * timers and clocks from the host (`host.ts`) or from the caller, so a test can drive them. Test
 * doubles may use Node's.
 */
const here = import.meta.dirname;
const root = join(here, "../../..");
const testOnly = /\.test\.ts$|fixture|test-host|harness/;
const globalTimer =
  /(?<![.\w])(?:globalThis\.)?(setTimeout|clearTimeout|setInterval|clearInterval)\(|(?<![.\w])(?:globalThis\.)?performance\.|globalThis\.performance\b/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return entry.name.endsWith(".ts") && !testOnly.test(entry.name) ? [path] : [];
  });
}

function offenders(dir: string): string[] {
  return sources(dir).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        globalTimer.test(line) && !line.trimStart().match(/^(\/\/|\*|\/\*)/)
          ? [`${relative(root, path)}:${index + 1}`]
          : [],
      ),
  );
}

test("no bridge module calls Node's timers or performance, which JavaScriptCore lacks", () => {
  expect(offenders(here)).toEqual([]);
});

/*
 * Shared code that sets a timer itself, today: each takes the timer as an option or runs behind
 * the shim. A new file here is a new place the phone could throw, so it is named on purpose.
 */
const knownShared = new Set([
  "access-http.ts",
  "browser-download.ts",
  "file-read-budget.ts",
  "monotonic.ts",
  "relay-route.ts",
  "spade-http.ts",
  "turn-steps.ts",
  "model-options.ts",
]);

test("shared client and ui-core code reaches for a global timer only in files named here", () => {
  const files = [
    ...offenders(join(root, "packages/client/src")),
    ...offenders(join(root, "packages/ui-core/src")),
  ].map((hit) => hit.slice(hit.lastIndexOf("/") + 1).replace(/:\d+$/, ""));
  expect([...new Set(files)].filter((file) => !knownShared.has(file))).toEqual([]);
});
