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

/** Protocol sources, whose `.meta()` annotations exist only for the generated protocol docs. */
const protocolSource = /\/packages\/protocol\/src\/[^?]*\.ts(?:\?|$)/;

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** A metadata or description annotation, from the receiver's end to the closing parenthesis. */
function metaCall(node: Node): [number, number] | undefined {
  if (node.type !== "CallExpression" || (node["arguments"] as unknown[]).length !== 1) return;
  const callee = node["callee"];
  if (!isNode(callee) || callee.type !== "MemberExpression" || callee["computed"]) return;
  const property = callee["property"];
  const object = callee["object"];
  if (
    !isNode(property) ||
    !["meta", "describe"].includes(String(property["name"])) ||
    !isNode(object)
  )
    return;
  return [object.end, node.end];
}

/**
 * Schema annotations (`.meta({...})`: constraint prose, examples, JSON Schema keywords) only
 * feed JSON Schema generation, which browser builds don't bundle (see above), and parsing never
 * reads them. They are several kilobytes of prose in the client worker, so browser builds drop
 * each `.meta(annotations)` and `.describe(text)` call from protocol sources. The call returns a registered copy of
 * its receiver, so the receiver alone parses identically. Removed spans become whitespace, so
 * every other position, and the sourcemap, is unchanged. The unused registry is stubbed too,
 * so metadata reads return undefined and attempts to register new metadata fail explicitly.
 */
export function zodWithoutMetadata(): Plugin {
  return {
    name: "ace:zod-without-metadata",
    load(id) {
      if (!id.endsWith("zod/v4/core/registries.js")) return null;
      return `
        const unavailable = () => { throw new Error("Zod metadata isn't bundled in the browser build."); };
        export const $input = Symbol("ZodInput");
        export const $output = Symbol("ZodOutput");
        export const $ZodRegistry = unavailable;
        export const registry = unavailable;
        export const globalRegistry = { get: () => undefined, add: unavailable };
      `;
    },
    transform(code, id) {
      if (!protocolSource.test(id) || (!code.includes(".meta(") && !code.includes(".describe(")))
        return null;
      const spans: [number, number][] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const entry of value) visit(entry);
          return;
        }
        if (!isNode(value)) return;
        const span = metaCall(value);
        // Annotations never nest schemas, so the receiver is the only part left to visit.
        if (span) {
          spans.push(span);
          visit((value["callee"] as Node)["object"]);
          return;
        }
        for (const key in value) if (key !== "type") visit(value[key]);
      };
      visit(this.parse(code));
      if (!spans.length) return null;
      let out = "";
      let at = 0;
      for (const [start, end] of spans.toSorted((a, b) => a[0] - b[0])) {
        out += code.slice(at, start) + code.slice(start, end).replace(/[^\n]/g, " ");
        at = end;
      }
      return { code: out + code.slice(at), map: null };
    },
  };
}
