import {
  canonical,
  nodes,
  object,
  schemaNode,
  resolve,
  strings,
  type JsonSchema,
  type Snapshot,
} from "./model.ts";

export interface Change {
  schema: string;
  path: string;
  kind: "additive" | "breaking" | "review";
  reason: string;
}
const annotations = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "examples",
  "$comment",
  "deprecated",
]);
const handled = new Set([
  "type",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);
const lower = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"];
const upper = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"];
function types(node: JsonSchema): string[] {
  return typeof node.type === "string" ? [node.type] : strings(node.type);
}
function values(node: JsonSchema): unknown[] | undefined {
  return Object.hasOwn(node, "const") ? [node.const] : node.enum;
}

export function compareSnapshots(previous: Snapshot, current: Snapshot): Change[] {
  const changes: Change[] = [];
  let compared = 0;
  if (previous.protocolVersion !== current.protocolVersion)
    changes.push({
      schema: "protocol",
      path: "$",
      kind: "breaking",
      reason: "Protocol version changed; negotiate the new version",
    });
  function compare(
    name: string,
    path: string,
    before: JsonSchema,
    after: JsonSchema,
    depth: number,
  ): Change[] {
    if (++compared > 100_000) throw new Error("Compatibility comparison exceeds 100000 nodes");
    const found: Change[] = [];
    const add = (kind: Change["kind"], reason: string) =>
      found.push({ schema: name, path, kind, reason });
    if (depth > 48) {
      add("review", "Comparison depth exceeds 48");
      return found;
    }
    const a = resolve(before, previous.schemas),
      b = resolve(after, current.schemas);
    const aUnion = nodes(a.anyOf ?? a.oneOf),
      bUnion = nodes(b.anyOf ?? b.oneOf);
    if (aUnion.length || bUnion.length) {
      const siblingValidation = (node: JsonSchema): string[] =>
        Object.keys(node).filter(
          (key) => !annotations.has(key) && key !== "anyOf" && key !== "oneOf",
        );
      if (aUnion.length !== 0 && bUnion.length === 0 && siblingValidation(a).length)
        add("review", "Union sibling constraints require review");
      if (bUnion.length !== 0 && aUnion.length === 0 && siblingValidation(b).length)
        add("review", "Union sibling constraints require review");
      // Each old branch must remain accepted by at least one new branch.
      const oldBranches = aUnion.length ? aUnion : [a];
      const newBranches = bUnion.length ? bUnion : [b];
      for (const [index, branch] of oldBranches.entries()) {
        const candidates = newBranches.map((next) =>
          compare(name, `${path}/variant${index}`, branch, next, depth + 1),
        );
        const compatible = candidates.find((candidate) =>
          candidate.every((change) => change.kind === "additive"),
        );
        if (compatible) found.push(...compatible);
        else add("breaking", `Union variant ${index} removed or narrowed`);
      }
      if (newBranches.length > oldBranches.length) add("additive", "Union variant added");
      // Constraints alongside a union must still be compared.
      const { anyOf: _a, oneOf: _b, ...aSiblings } = a;
      const { anyOf: _c, oneOf: _d, ...bSiblings } = b;
      if (aUnion.length && bUnion.length)
        found.push(...compare(name, path, aSiblings, bSiblings, depth + 1));
      if (a.oneOf === undefined && b.oneOf !== undefined)
        add("review", "Union changed to exclusive oneOf");
      return found;
    }
    const aAll = nodes(a.allOf),
      bAll = nodes(b.allOf);
    if (aAll.length !== bAll.length) add("review", "Intersection branches changed");
    else
      for (const [index, branch] of aAll.entries()) {
        const next = bAll[index];
        if (next) found.push(...compare(name, `${path}/allOf${index}`, branch, next, depth + 1));
      }
    const aTypes = types(a),
      bTypes = types(b);
    if (
      bTypes.length &&
      (!aTypes.length ||
        aTypes.some(
          (type) => !bTypes.includes(type) && !(type === "integer" && bTypes.includes("number")),
        ))
    )
      add("breaking", "Type narrowed");
    else if (canonical(aTypes) !== canonical(bTypes)) add("additive", "Type widened");
    const aValues = values(a),
      bValues = values(b);
    if (
      bValues &&
      (!aValues ||
        aValues.some((value) => !bValues.some((next) => canonical(next) === canonical(value))))
    )
      add("breaking", "Enum or literal narrowed");
    else if (canonical(aValues) !== canonical(bValues)) add("additive", "Enum or literal widened");
    const aProps = object(a.properties),
      bProps = object(b.properties);
    for (const [key, value] of Object.entries(aProps)) {
      if (!Object.hasOwn(bProps, key))
        found.push({
          schema: name,
          path: `${path}/${key}`,
          kind: "breaking",
          reason: "Field removed",
        });
      else
        found.push(
          ...compare(name, `${path}/${key}`, schemaNode(value), schemaNode(bProps[key]), depth + 1),
        );
    }
    for (const key of Object.keys(bProps))
      if (!Object.hasOwn(aProps, key))
        found.push({
          schema: name,
          path: `${path}/${key}`,
          kind: "additive",
          reason: "Field added",
        });
    const aRequired = strings(a.required),
      bRequired = strings(b.required);
    for (const key of bRequired)
      if (!aRequired.includes(key))
        found.push({
          schema: name,
          path: `${path}/${key}`,
          kind: "breaking",
          reason: "Field became required",
        });
    for (const key of aRequired)
      if (!bRequired.includes(key))
        found.push({
          schema: name,
          path: `${path}/${key}`,
          kind: "additive",
          reason: "Field became optional",
        });
    if (b.additionalProperties === false && a.additionalProperties !== false)
      add("breaking", "Unknown fields now forbidden");
    else if (a.additionalProperties === false && b.additionalProperties !== false)
      add("additive", "Unknown fields now allowed");
    if (typeof b.additionalProperties === "object")
      found.push(
        ...compare(
          name,
          `${path}/*`,
          object(a.additionalProperties),
          b.additionalProperties,
          depth + 1,
        ),
      );
    if (b.items !== undefined)
      found.push(
        ...compare(name, `${path}[]`, schemaNode(a.items), schemaNode(b.items), depth + 1),
      );
    for (const key of [...lower, ...upper]) {
      if (canonical(a[key]) === canonical(b[key])) continue;
      const oldValue = a[key],
        newValue = b[key];
      const narrowed =
        newValue !== undefined &&
        (oldValue === undefined ||
          (typeof oldValue === "number" &&
            typeof newValue === "number" &&
            (lower.includes(key) ? newValue > oldValue : newValue < oldValue)));
      add(narrowed ? "breaking" : "additive", `${key} ${narrowed ? "tightened" : "relaxed"}`);
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (annotations.has(key) || handled.has(key) || canonical(a[key]) === canonical(b[key]))
        continue;
      add("review", `Validation keyword ${key} changed`);
    }
    return found;
  }
  for (const [name, schema] of Object.entries(previous.schemas)) {
    const next = current.schemas[name];
    if (!Object.hasOwn(current.schemas, name) || !next)
      changes.push({
        schema: name,
        path: "$",
        kind: "breaking",
        reason: "Schema removed or renamed",
      });
    else changes.push(...compare(name, "$", schema, next, 0));
  }
  for (const name of Object.keys(current.schemas))
    if (!Object.hasOwn(previous.schemas, name))
      changes.push({ schema: name, path: "$", kind: "additive", reason: "Schema added" });
  return changes;
}
