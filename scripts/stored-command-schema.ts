// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { ProjectIconUrl } from "@ace/protocol";
import { z } from "zod";

// JavaScript predicates have no schema representation. Name the Rust equivalents here.
// Fingerprint the normalized predicate source so edits require reviewing the Rust check.
const refinements = new Map<string, string>([
  ["value=>value.split('/').every(part=>part!=='.'&&part!=='..')", "owner_path"],
  ["name=>!name.startsWith('-')&&!name.startsWith('.')", "remote_name"],
  ["v=>Object.keys(v).length<=64", "keys_64"],
  ["v=>v.default===undefined||typeofv.default===v.type", "parameter_default"],
  ["lines=>lines.end>=lines.start", "line_range"],
  ["value=>Object.keys(value).length<=32", "keys_32"],
  ["value=>newTextEncoder().encode(value).byteLength<=65536", "patch_bytes"],
  ["value=>value.trim().length>0", "nonblank"],
  ["a=>a.reviewers.length+(a.teams?.length??0)>0", "reviewers"],
  ["path=>!path.includes('\\0')", "no_nul"],
  ["value=>value!=='.'&&value!=='..'", "repository_name"],
  ["value=>value===value.trim()&&value!=='.'&&value!=='..'&&!value.endsWith('.')", "project_name"],
  ["value=>ProjectIconUrl.safeParse(value).success", "url"],
  ["value=>value.model===undefined||value.provider!==undefined", "model_provider"],
  ["value=>value.number!==undefined!==(value.all===true)", "unlink_selection"],
  ["s=>!s.startsWith('-')&&!s.includes('\\0')", "review_ref"],
  ["p=>p.end>=p.start&&p.end-p.start<100", "review_line_range"],
  [
    "path=>!path.startsWith('/')&&!path.includes('\\\\')&&[...path].every(char=>char.charCodeAt(0)>=32)&&!/^[A-Za-z]:/.test(path)&&path.split('/').every(part=>part!=='..'&&part!=='.'&&part!=='')",
    "review_path",
  ],
  [
    "f=>[...f.before,...f.lines,...f.after].reduce((n,s)=>n+s.length,0)<=8192",
    "fingerprint_length",
  ],
  [
    "t=>t.lanes.length<=t.budget.maxLanes&&(t.kind!=='coordinator'||t.lanes.length===1)",
    "orchestration_lanes",
  ],
  ["c=>Boolean(c.command[0])&&c.command.every(arg=>!arg.includes('\\0'))", "orchestration_command"],
  ["id=>!['__proto__','constructor','prototype'].includes(id)", "orchestration_id"],
  ["value=>Object.keys(value).length<=24", "keys_24"],
]);

/** The URL predicate closes over a Zod schema, so its source alone cannot guard it. */
export function assertProjectIconUrlRules(): void {
  // oxlint-disable-next-line no-underscore-dangle -- Fingerprint the actual checker.
  const check = ProjectIconUrl._zod.check;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        ProjectIconUrl.def,
        check.toString(),
        z.core.validateURL.toString(),
        z.core.canParseURL.toString(),
        z.core.parseURLObject.toString(),
        z.core.stripTabAndNewline.toString(),
        z.core.urlHostnameOk.toString(),
        z.core.urlProtocolOk.toString(),
      ]),
    )
    .digest("hex");
  if (fingerprint !== "2860bfeaabf6991ff6f06f18e874a1e27d58e82b0f88057da512289e5d1407e8")
    throw new Error("ProjectIconUrl or Zod URL validation changed. Review the Rust refinement.");
}

export function refinementNames(): string[] {
  return [...new Set(refinements.values())].toSorted();
}

function refinementName(source: string): string | undefined {
  return refinements.get(
    source
      .replaceAll("void 0", "undefined")
      .replaceAll("\\x00", "\\0")
      .replaceAll("!0", "true")
      .replaceAll('"', "'")
      .replace(/\((\w+)\)\s*=>/g, "$1=>")
      .replace(/\s+/g, ""),
  );
}

function unsupported(path: string, detail: string): never {
  throw new Error(`${path} uses an unsupported stored command rule (${detail})`);
}

function compileCheck(check: z.core.$ZodCheck, path: string): object {
  // oxlint-disable-next-line no-underscore-dangle -- Zod exposes runtime definitions here.
  const def = check._zod.def as z.core.$ZodChecks["_zod"]["def"] | z.core.$ZodCustomDef;
  switch (def.check) {
    case "min_length":
      return { check: def.check, minimum: def.minimum };
    case "max_length":
      return { check: def.check, maximum: def.maximum };
    case "greater_than":
    case "less_than":
      if (typeof def.value !== "number" || !Number.isFinite(def.value))
        return unsupported(path, "nonfinite bound");
      return { check: def.check, value: def.value, inclusive: def.inclusive };

    case "number_format":
      if ("format" in def && def.format === "safeint")
        return { check: def.check, format: def.format };
      return unsupported(path, "number format");
    case "string_format": {
      if ("pattern" in def && def.pattern instanceof RegExp && def.pattern.flags === "")
        return { check: "regex", source: def.pattern.source };
      return unsupported(path, "string format");
    }
    case "custom": {
      const source = "fn" in def ? String(def.fn) : "";
      const name = refinementName(source);
      if (name === undefined) return unsupported(path, source);
      return { check: "refinement", name };
    }
    default:
      return unsupported(path, def.check);
  }
}

export function definition(schema: z.core.$ZodType): z.core.$ZodTypes["_zod"]["def"] {
  // The walk explicitly rejects Zod types outside the generated table's vocabulary.
  // oxlint-disable-next-line no-underscore-dangle -- Read the Zod runtime definition.
  return (schema as z.core.$ZodTypes)._zod.def;
}

export function commandSchema(schema: z.core.$ZodType, path = "Command"): object {
  const def = definition(schema);
  if ("coerce" in def && def.coerce) return unsupported(path, "coercion");
  const checks = def.checks?.map((check) => compileCheck(check, path));
  const shape = compileShape(def, path);
  return checks?.length ? { ...shape, checks } : shape;
}

type Definition = z.core.$ZodTypes["_zod"]["def"];

function compileShape(def: Definition, path: string): object {
  const type = def.type;
  const child = (schema: z.core.$ZodType, name: string) => commandSchema(schema, `${path}.${name}`);
  switch (type) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "unknown":
      return { type };
    case "object": {
      if (def.catchall && definition(def.catchall).type !== "never")
        return unsupported(path, "object catchall");
      return {
        type,
        strict: def.catchall !== undefined,
        fields: Object.entries(def.shape).map(([key, schema]) => [key, child(schema, key)]),
      };
    }
    case "optional":
    case "nullable":
      return { type, inner: child(def.innerType, type) };
    case "default":
      return { type, inner: child(def.innerType, type), value: def.defaultValue };
    case "array":
      return { type, inner: child(def.element, "[]") };
    case "enum":
      return { type: "literal", values: Object.values(def.entries) };
    case "literal":
      return { type, values: def.values };
    case "record":
      if (definition(def.keyType).type !== "string" || def.mode === "loose" || def.partial)
        return unsupported(path, "record keys");
      return { type, keys: child(def.keyType, "key"), entries: child(def.valueType, "value") };
    case "intersection": {
      const left = definition(def.left);
      const right = definition(def.right);
      if (
        left.type !== "record" ||
        right.type !== "object" ||
        right.checks?.length ||
        (right.catchall && definition(right.catchall).type !== "never")
      )
        return unsupported(path, "intersection other than a record with fixed fields");
      return { type, left: child(def.left, "left"), right: child(def.right, "right") };
    }
    case "union": {
      if ("discriminator" in def && typeof def.discriminator === "string") {
        const discriminator = def.discriminator;
        const variants = def.options.flatMap((option) => {
          const arm = definition(option);
          const field = arm.type === "object" ? arm.shape[discriminator] : undefined;
          const tag = field && definition(field);
          if (tag?.type !== "literal") return unsupported(path, "nonliteral discriminator");
          return tag.values.map((value: unknown) => {
            if (typeof value !== "string") return unsupported(path, "nonstring discriminator");
            return [value, child(option, value)] as const;
          });
        });
        if (new Set(variants.map(([tag]) => tag)).size !== variants.length)
          return unsupported(path, "duplicate discriminator");
        return { type: "tagged", discriminator, variants: Object.fromEntries(variants) };
      }
      if ("inclusive" in def && def.inclusive === false)
        return unsupported(path, "exclusive union");
      return { type, options: def.options.map((option, index) => child(option, String(index))) };
    }
    default:
      return unsupported(path, type);
  }
}
