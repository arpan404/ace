import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { spadePersonOnlyRoute } from "./spade-person-only.ts";

/*
 * Route parity (ADR 0190, amendment 1): every route whose Spade handler reads the person's stamp
 * is on the one list the daemon stamps from and the app routes by. A guarded route Spade adds
 * that the list doesn't name would reach Spade unstamped from every window, and every window
 * would be refused: this fails first.
 */

const api = join(import.meta.dirname, "../../../spade/crates/spade-server/src/api");

/** Routes the daemon calls itself and stamps on its own, never a window's change. */
const daemonOwn = new Set([
  // The daemon binds this Spade to an organization (ADR 0206, `org-host/link.ts`).
  "PUT /v1/org",
  "DELETE /v1/org",
]);

/** The text of the call or block opening at `start` (a `(` or `{`), balanced. */
function balanced(text: string, start: number): string {
  const open = text[start];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++;
    else if (text[index] === close && --depth === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
}

/** Every Rust file of Spade's API, by module name. */
const files = new Map(
  readdirSync(api)
    .filter((name) => name.endsWith(".rs"))
    .map((name) => [name.slice(0, -3), readFileSync(join(api, name), "utf8")]),
);

/** The body of `module`'s function `name`, or undefined when it has none. */
function body(module: string, name: string): string | undefined {
  const text = files.get(module) ?? "";
  const at = new RegExp(`fn ${name}\\b[^{]*\\{`).exec(text);
  return at ? balanced(text, at.index + at[0].length - 1) : undefined;
}

/** Whether `module`'s function `name` reads the person's stamp, itself or through a helper. */
function readsStamp(module: string, name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const text = body(module, name);
  if (text === undefined) return false;
  if (/person_stamp\(|Say::new\(|attest::HEADER/.test(text)) return true;
  // Plain calls only: a method (`security.effective(…)`) isn't this module's function.
  return [...text.matchAll(/(?<![.\w:])([a-z_][a-z0-9_]*)\(/g)].some(
    ([, called = ""]) => called !== name && readsStamp(module, called, seen),
  );
}

/** Every route Spade's API registers, with the method and the handler module and name. */
function routes(): { method: string; path: string; module: string; handler: string }[] {
  const found: { method: string; path: string; module: string; handler: string }[] = [];
  for (const [module, text] of files) {
    for (const at of text.matchAll(/\.route\(/g)) {
      const call = balanced(text, (at.index ?? 0) + ".route".length);
      const path = /^\(\s*"([^"]+)"/.exec(call)?.[1];
      if (!path) continue;
      for (const each of call.matchAll(/\b(get|post|put|delete|patch)\(\s*([\w:]+)\s*\)/g)) {
        const [, method = "", handler = ""] = each;
        const parts = handler.split("::");
        found.push({
          method: method.toUpperCase(),
          path,
          module: parts.length > 1 ? (parts.at(-2) ?? module) : module,
          handler: parts.at(-1) ?? handler,
        });
      }
    }
  }
  return found;
}

test("every Spade route that reads the person's stamp is on the shared person-only list", () => {
  const all = routes();
  const guarded = all.filter((route) => readsStamp(route.module, route.handler));
  // The scan finds Spade's guarded handlers at all: Permissions, Full access, moves, the org.
  expect(guarded.map((route) => `${route.method} ${route.path}`)).toEqual(
    expect.arrayContaining([
      "PUT /agents/{id}/security/permissions",
      "PUT /agents/{id}/security/network",
      "DELETE /agents/{id}/security/plugin-network",
      "PUT /security/autonomy",
      "PUT /moves/{id}/accept",
    ]),
  );
  const missing = guarded
    .map((route) => ({
      route: `${route.method} /v1${route.path}`,
      sample: `/v1${route.path.replaceAll(/\{[^}]+\}/g, "a_1")}`,
      method: route.method,
    }))
    .filter((route) => !daemonOwn.has(route.route))
    .filter((route) => spadePersonOnlyRoute(route.method, route.sample) === undefined)
    .map((route) => route.route);
  expect(missing).toEqual([]);
});
