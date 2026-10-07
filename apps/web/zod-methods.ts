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

/**
 * The worker never uses fallback schemas or schema introspection; the page's saved Choices still
 * need .catch(). Metadata getters would call the omitted JSON Schema processor anyway.
 * Keep .array(): browser origin replies use it at runtime, and perf workers build core
 * validation schemas with it too. These omissions apply to every Vite worker.
 */
export const droppedWorkerZodMethods = {
  ...droppedZodMethods,
  ZodType: [
    ...(droppedZodMethods["ZodType"] ?? []),
    "or",
    "parseAsync",
    "safeParseAsync",
    "catch",
    "with",
    "toJSONSchema",
    "spa",
    "isOptional",
    "isNullable",
    "nullish",
    "describe",
    "meta",
    "register",
    "apply",
  ],
  ZodObject: [...(droppedZodMethods["ZodObject"] ?? []), "merge", "loose", "strip"],
  ZodNumber: [
    ...(droppedZodMethods["ZodNumber"] ?? []),
    "gt",
    "lt",
    "negative",
    "nonpositive",
    "safe",
    "gte",
    "lte",
    "minValue",
    "maxValue",
    "isInt",
    "format",
  ],
  ZodArray: ["length", "nonempty"],
  ZodTuple: ["rest", "partial"],
  ZodInstanceOf: ["properties"],
  ZodEnum: ["extract"],
  _ZodString: [
    "format",
    "minLength",
    "maxLength",
    "length",
    "nonempty",
    "trim",
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
 * The member tables of `export const <name> = core.$constructor("<name>", init, members)`, where
 * `members` is `{ ... }` or `util.derived(getters, { ... })`.
 */
function memberTables(declarator: Node): [string, Node][] {
  const name = nameOf(declarator["id"]);
  const call = declarator["init"];
  if (!name || !isNode(call) || call.type !== "CallExpression") return [];
  const table = (call["arguments"] as unknown[])[2];
  let tables: unknown[] = [table];
  if (isNode(table) && table.type === "CallExpression") {
    const callee = table["callee"];
    if (
      isNode(callee) &&
      callee.type === "MemberExpression" &&
      nameOf(callee["property"]) === "derived"
    )
      tables = table["arguments"] as unknown[];
  }
  return tables.flatMap((member): [string, Node][] =>
    isNode(member) && member.type === "ObjectExpression" ? [[name, member]] : [],
  );
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
          `\nfunction ${stub}(name) { throw new Error(\`Zod's .\${name}() is left out of browser builds.\`); }\n`,
        );
        return { code: out.toString(), map: out.generateMap({ hires: true, source: id }) };
      }
      if (!classicSchemas.test(id.split("?")[0] ?? id)) return null;
      const out = new MagicString(code);
      let changed = false;
      for (const declarator of declarators(this.parse(code) as unknown as Node)) {
        // Some methods still live on instances in Zod, notably enum extraction.
        const owner = nameOf(declarator["id"]);
        const call = declarator["init"];
        const init =
          isNode(call) && Array.isArray(call["arguments"]) ? call["arguments"][1] : undefined;
        const body = isNode(init) ? init["body"] : undefined;
        if (owner && isNode(body) && Array.isArray(body["body"]))
          for (const statement of body["body"]) {
            const assignment = isNode(statement) ? statement["expression"] : undefined;
            if (!isNode(assignment) || assignment.type !== "AssignmentExpression") continue;
            const left = assignment["left"];
            const right = assignment["right"];
            if (
              !isNode(left) ||
              left.type !== "MemberExpression" ||
              left["computed"] ||
              !isNode(right)
            )
              continue;
            const method = nameOf(left["property"]);
            if (!method || !dropped[owner]?.includes(method)) continue;
            out.overwrite(right.start, right.end, `() => ${stub}("${method}")`);
            changed = true;
          }
        for (const found of memberTables(declarator)) {
          const names = new Set(dropped[found[0]]);
          if (!names.size) continue;
          const removed: { node: Node; name: string }[] = [];
          for (const member of found[1]["properties"] as unknown[]) {
            if (!isNode(member) || member.type !== "Property" || member["computed"]) continue;
            const name = nameOf(member["key"]);
            if (name && names.has(name)) removed.push({ node: member, name });
          }
          const first = removed[0];
          if (!first) continue;
          // A shared factory keeps every unsupported method's diagnostic while avoiding a
          // repeated function body for each prototype entry.
          out.overwrite(
            first.node.start,
            first.node.end,
            `.../* @__PURE__ */ ${stub}Methods(${JSON.stringify(removed.map(({ name }) => name).join(" "))})`,
          );
          for (const { node } of removed.slice(1)) {
            let end = node.end;
            while (/\s/.test(code[end] ?? "")) end++;
            out.remove(node.start, code[end] === "," ? end + 1 : node.end);
          }
          changed = true;
        }
      }
      if (!changed) return null;
      out.append(
        `\nfunction ${stub}(name) {\n  throw new Error(\`Zod's .\${name}() is left out of browser builds.\`);\n}\nfunction ${stub}Methods(names) { return Object.fromEntries(names.split(" ").map(name => [name, () => ${stub}(name)])); }\n`,
      );
      return { code: out.toString(), map: out.generateMap({ hires: true, source: id }) };
    },
  };
}
