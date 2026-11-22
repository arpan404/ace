import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/*
 * The bridge runs in JavaScriptCore on the phone, which has no setTimeout or clearTimeout: a
 * module that reaches for them throws a ReferenceError there, though every Node test passes.
 * Timers come from the host scheduler (`host.ts`) or one passed in. Test doubles may use Node's.
 */
const here = import.meta.dirname;
const testOnly = /\.test\.ts$|fixture|test-host|harness/;
const globalTimer = /(?<![.\w])(setTimeout|clearTimeout|setInterval|clearInterval)\(/;

test("no module the phone runs calls Node's timers, which JavaScriptCore doesn't have", () => {
  const offenders = readdirSync(here)
    .filter((name) => name.endsWith(".ts") && !testOnly.test(name))
    .flatMap((name) =>
      readFileSync(join(here, name), "utf8")
        .split("\n")
        .flatMap((line, index) =>
          globalTimer.test(line) && !line.trimStart().startsWith("//")
            ? [`${name}:${index + 1}`]
            : [],
        ),
    );
  expect(offenders).toEqual([]);
});
