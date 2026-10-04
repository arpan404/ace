import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/**
 * Classic Zod schemas reference its JSON Schema generator (about 18 KB minified) from every
 * schema type, so it ships in each bundle that uses classic Zod: the client worker and the
 * routes that parse protocol replies. Nothing in the browser generates JSON Schema (the
 * protocol docs are generated in Node), so these builds get a stand-in that throws if anyone
 * ever asks. The two method factories `~standard` calls eagerly (Standard Schema, used by
 * TanStack Router and Form) still return functions; only calling those throws.
 */

const generator = /zod\/v4\/core\/(to-json-schema|json-schema-processors)\.js$/;
/** Factories that run when a schema's `~standard` is read; they must hand back a function. */
const factories = new Set(["createToJSONSchemaMethod", "createStandardJSONSchemaMethod"]);

function exportNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/^export (?:const|function|class|let) (\w+)/gm))
    if (match[1]) names.add(match[1]);
  for (const match of source.matchAll(/^export \{([^}]*)\}/gm))
    for (const part of match[1]?.split(",") ?? []) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) names.add(name);
    }
  return [...names];
}

export function zodWithoutJsonSchema(): Plugin {
  return {
    name: "ace:zod-without-json-schema",
    enforce: "pre",
    load(id) {
      const path = id.split("?")[0] ?? id;
      if (!generator.test(path)) return null;
      const lines = [
        'const unavailable = () => { throw new Error("JSON Schema generation isn\'t bundled in the browser build."); };',
      ];
      for (const name of exportNames(readFileSync(path, "utf8")))
        lines.push(
          factories.has(name)
            ? `export const ${name} = () => unavailable;`
            : `export const ${name} = unavailable;`,
        );
      return lines.join("\n");
    },
  };
}
