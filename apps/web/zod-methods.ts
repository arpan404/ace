import { MagicString } from "magic-string";
import type { Plugin } from "vite";

/*
 * Classic Zod installs every method on its schema prototypes, so a bundle that uses classic Zod
 * keeps each method and everything it reaches even when nothing calls it: string formats with
 * their classes and regexes, codecs (`encode`, `decode` and their async and safe forms) and a few
 * wrappers. That is 2 to 3 KB gzip in each worker and again in the page. Browser builds replace
 * the methods below, which no browser code calls, with a stand-in that throws if anyone ever
 * does; the `z.email()`-style functions are untouched and stay tree-shaken as usual.
 *
 * Calling one of these on a schema in code the browser loads throws at once, usually while the
 * module builds its schemas. Remove the name from this list to bring the method back.
 */
export const droppedZodMethods: Readonly<Record<string, readonly string[]>> = {
  ZodType: [
    "exactOptional",
    "nonoptional",
    "prefault",
    "readonly",
    "overwrite",
    "validate",
    "validateAsync",
    "encode",
    "decode",
    "encodeAsync",
    "decodeAsync",
    "safeEncode",
    "safeDecode",
    "safeEncodeAsync",
    "safeDecodeAsync",
  ],
  ZodNumber: ["multipleOf", "step"],
  ZodObject: ["exactPartial", "required"],
  // `url`, `uuid` and `date` are used by the protocol.
  ZodString: [
    "email",
    "jwt",
    "emoji",
    "guid",
    "uuidv4",
    "uuidv6",
    "uuidv7",
    "nanoid",
    "cuid",
    "cuid2",
    "ulid",
    "base64",
    "base64url",
    "xid",
    "ksuid",
    "ipv4",
    "ipv6",
    "cidrv4",
    "cidrv6",
    "e164",
    "datetime",
    "time",
    "duration",
  ],
};

/** The worker never uses fallback schemas; the page's saved Choices still need .catch(). */
export const droppedWorkerZodMethods = {
  ...droppedZodMethods,
  ZodType: [
    ...(droppedZodMethods["ZodType"] ?? []),
    "array",
    "or",
    "parseAsync",
    "safeParseAsync",
    "catch",
  ],
  ZodObject: [...(droppedZodMethods["ZodObject"] ?? []), "merge"],
  _ZodString: [
    "includes",
    "startsWith",
    "endsWith",
    "lowercase",
    "uppercase",
    "normalize",
    "toLowerCase",
    "toUpperCase",
    "slugify",
  ],
  ZodError: ["format", "flatten"],
};

const classicSchemas = /zod\/v4\/classic\/schemas\.js$/;
const classicErrors = /zod\/v4\/classic\/errors\.js$/;
const stub = "__aceDroppedZodMethod";

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

const nameOf = (node: unknown): string | undefined =>
  isNode(node) && node.type === "Identifier" && typeof node["name"] === "string"
    ? node["name"]
    : isNode(node) && node.type === "Literal" && typeof node["value"] === "string"
      ? node["value"]
      : undefined;

/**
 * The member table of `export const <name> = core.$constructor("<name>", init, members)`, where
 * `members` is `{ ... }` or `util.derived(getters, { ... })`.
 */
function memberTable(declarator: Node): [string, Node] | undefined {
  const name = nameOf(declarator["id"]);
  const call = declarator["init"];
  if (!name || !isNode(call) || call.type !== "CallExpression") return;
  let table = (call["arguments"] as unknown[])[2];
  if (isNode(table) && table.type === "CallExpression") {
    const callee = table["callee"];
    if (
      isNode(callee) &&
      callee.type === "MemberExpression" &&
      nameOf(callee["property"]) === "derived"
    )
      table = (table["arguments"] as unknown[])[1];
  }
  return isNode(table) && table.type === "ObjectExpression" ? [name, table] : undefined;
}

function* declarators(program: Node): Generator<Node> {
  for (const statement of program["body"] as unknown[]) {
    const declaration =
      isNode(statement) && statement.type === "ExportNamedDeclaration"
        ? statement["declaration"]
        : statement;
    if (!isNode(declaration) || declaration.type !== "VariableDeclaration") continue;
    for (const declarator of declaration["declarations"] as unknown[])
      if (isNode(declarator)) yield declarator;
  }
}

/**
 * Replaces each dropped member of classic Zod's schema prototypes with a method that throws,
 * naming itself, with a sourcemap so the stack points at the member it replaced.
 */
export function zodWithoutUnusedMethods(
  dropped: Readonly<Record<string, readonly string[]>> = droppedZodMethods,
): Plugin {
  return {
    name: "ace:zod-without-unused-methods",
    transform(code, id) {
      if (classicErrors.test(id.split("?")[0] ?? id) && dropped["ZodError"]?.length) {
        const out = new MagicString(code);
        out.replaceAll(
          /_lazyMethod\(proto, "(format|flatten)",[^;]+;/g,
          (_match, name: string) =>
            `_lazyMethod(proto, "${name}", () => () => ${stub}("${name}"));`,
        );
        out.append(
          `\nfunction ${stub}(name) { throw new Error(\`Zod's .\${name}() is left out of browser builds (apps/web/zod-methods.ts).\`); }\n`,
        );
        return { code: out.toString(), map: out.generateMap({ hires: true, source: id }) };
      }
      if (!classicSchemas.test(id.split("?")[0] ?? id)) return null;
      const out = new MagicString(code);
      let changed = false;
      for (const declarator of declarators(this.parse(code) as unknown as Node)) {
        const found = memberTable(declarator);
        const names = found && new Set(dropped[found[0]]);
        if (!found || !names?.size) continue;
        for (const member of found[1]["properties"] as unknown[]) {
          if (!isNode(member) || member.type !== "Property" || member["computed"]) continue;
          const name = nameOf(member["key"]);
          if (!name || !names.has(name)) continue;
          out.overwrite(member.start, member.end, `${name}() { ${stub}("${name}"); }`);
          changed = true;
        }
      }
      if (!changed) return null;
      out.append(
        `\nfunction ${stub}(name) {\n  throw new Error(\`Zod's .\${name}() is left out of browser builds (apps/web/zod-methods.ts).\`);\n}\n`,
      );
      return { code: out.toString(), map: out.generateMap({ hires: true, source: id }) };
    },
  };
}
