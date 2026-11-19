import type { Plugin } from "vite";

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : []);

/** The query that names one piece of a protocol module. */
const pieceQuery = /\?ace-piece=(\d+)$/;
const protocolModule = /\/packages\/protocol\/src\/[^?/]+\.ts$/;

/** A protocol module path with any piece query removed, for guards and size reports. */
export const pieceModule = (id: string): string => id.replace(pieceQuery, "");

interface Binding {
  source: string;
  /** The imported name, `default`, or `*` for a namespace import. */
  imported: string;
}
interface Unit {
  start: number;
  end: number;
  names: string[];
  references: Set<string>;
  /** Whether evaluating it could be observed (`zodPureSchemas` treats the rest as pure). */
  effects: boolean;
}
interface Piece {
  units: Unit[];
  effects: boolean;
}
export interface Split {
  facade: string;
  pieces: string[];
  /** Pieces that keep the facade's evaluation semantics: imported for effect by it. */
  effects: boolean[];
}

const nameOf = (node: unknown): string | undefined =>
  isNode(node) && node.type === "Identifier" && typeof node["name"] === "string"
    ? node["name"]
    : isNode(node) && node.type === "Literal" && typeof node["value"] === "string"
      ? node["value"]
      : undefined;

/** Names a binding pattern declares. */
function patternNames(pattern: unknown, into: string[] = []): string[] {
  if (!isNode(pattern)) return into;
  switch (pattern.type) {
    case "Identifier":
      into.push(String(pattern["name"]));
      break;
    case "ObjectPattern":
      for (const property of nodes(pattern["properties"]))
        patternNames(
          property.type === "RestElement" ? property["argument"] : property["value"],
          into,
        );
      break;
    case "ArrayPattern":
      for (const element of nodes(pattern["elements"])) patternNames(element, into);
      break;
    case "RestElement":
      patternNames(pattern["argument"], into);
      break;
    case "AssignmentPattern":
      patternNames(pattern["left"], into);
      break;
  }
  return into;
}

/**
 * Every identifier a statement could read. Over-counting (a parameter that shadows a top-level
 * name) only adds an import of something the module already imports or declares.
 */
function references(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const entry of node) references(entry, into);
    return into;
  }
  if (!isNode(node)) return into;
  switch (node.type) {
    case "Identifier":
      into.add(String(node["name"]));
      return into;
    case "MemberExpression":
      references(node["object"], into);
      if (node["computed"]) references(node["property"], into);
      return into;
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
      if (node["computed"]) references(node["key"], into);
      references(node["value"], into);
      return into;
    case "LabeledStatement":
      references(node["body"], into);
      return into;
    case "BreakStatement":
    case "ContinueStatement":
      return into;
  }
  for (const key in node)
    if (key !== "type" && key !== "start" && key !== "end") references(node[key], into);
  return into;
}

/** Initializers `zodPureSchemas` marks pure, or that evaluate to a value without running code. */
const pureInit = (init: unknown): boolean =>
  init === null ||
  init === undefined ||
  (isNode(init) &&
    ([
      "CallExpression",
      "NewExpression",
      "ArrayExpression",
      "ObjectExpression",
      "ArrowFunctionExpression",
      "FunctionExpression",
      "Literal",
      "Identifier",
    ].includes(init.type) ||
      (init.type === "TemplateLiteral" && nodes(init["expressions"]).length === 0)));

/** Strongly connected units, each list in source order, so a cycle stays one module. */
function components(units: Unit[], owner: Map<string, number>): number[][] {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  const out: number[][] = [];
  let next = 0;
  const visit = (at: number) => {
    index.set(at, next);
    low.set(at, next++);
    stack.push(at);
    onStack.add(at);
    for (const name of units[at]?.references ?? []) {
      const to = owner.get(name);
      if (to === undefined || to === at) continue;
      if (!index.has(to)) {
        visit(to);
        low.set(at, Math.min(low.get(at) ?? 0, low.get(to) ?? 0));
      } else if (onStack.has(to)) low.set(at, Math.min(low.get(at) ?? 0, index.get(to) ?? 0));
    }
    if (low.get(at) !== index.get(at)) return;
    const group: number[] = [];
    let member: number | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      group.push(member);
    } while (member !== at);
    out.push(group.toSorted((a, b) => a - b));
  };
  for (let at = 0; at < units.length; at++) if (!index.has(at)) visit(at);
  return out.toSorted((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

const specifier = (source: string) => JSON.stringify(source);
const importOf = (local: string, binding: Binding) =>
  binding.imported === "*"
    ? `import * as ${local} from ${specifier(binding.source)};`
    : binding.imported === "default"
      ? `import ${local} from ${specifier(binding.source)};`
      : `import { ${binding.imported === local ? local : `${binding.imported} as ${local}`} } from ${specifier(binding.source)};`;

/**
 * Splits a protocol module (after TypeScript is stripped) into one module per top-level
 * declaration, merging declarations that refer to each other, and a facade that re-exports
 * them. Undefined when the module holds anything but imports, exports and `const`, function
 * and class declarations, so it is left whole.
 */
export function splitModule(code: string, program: unknown, path: string): Split | undefined {
  if (!isNode(program)) return undefined;
  const imports = new Map<string, Binding>();
  const units: Unit[] = [];
  const facade: string[] = [];
  /** Exported name to the local or imported binding it names. */
  const exported: [exportedName: string, local: string][] = [];
  for (const statement of nodes(program["body"])) {
    if (statement.type === "ImportDeclaration") {
      const source = String((statement["source"] as Node)["value"]);
      const specifiers = nodes(statement["specifiers"]);
      if (!specifiers.length) facade.push(code.slice(statement.start, statement.end));
      for (const entry of specifiers) {
        const local = nameOf(entry["local"]);
        if (!local) return undefined;
        const imported =
          entry.type === "ImportNamespaceSpecifier"
            ? "*"
            : entry.type === "ImportDefaultSpecifier"
              ? "default"
              : nameOf(entry["imported"]);
        if (!imported) return undefined;
        imports.set(local, { source, imported });
      }
      continue;
    }
    if (statement.type === "ExportAllDeclaration") {
      facade.push(code.slice(statement.start, statement.end));
      continue;
    }
    let declaration: Node = statement;
    if (statement.type === "ExportNamedDeclaration") {
      if (statement["source"]) {
        facade.push(code.slice(statement.start, statement.end));
        continue;
      }
      if (!isNode(statement["declaration"])) {
        for (const entry of nodes(statement["specifiers"])) {
          const local = nameOf(entry["local"]);
          const name = nameOf(entry["exported"]);
          if (!local || !name) return undefined;
          exported.push([name, local]);
        }
        continue;
      }
      declaration = statement["declaration"];
    }
    const isExport = declaration !== statement;
    let names: string[];
    let effects: boolean;
    if (declaration.type === "VariableDeclaration") {
      // A `let` or `var` can be reassigned, which an imported binding cannot follow.
      if (declaration["kind"] !== "const") return undefined;
      const declarators = nodes(declaration["declarations"]);
      names = declarators.flatMap((entry) => patternNames(entry["id"]));
      effects = declarators.some((entry) => !pureInit(entry["init"]));
    } else if (declaration.type === "FunctionDeclaration") {
      names = patternNames(declaration["id"]);
      effects = false;
    } else if (declaration.type === "ClassDeclaration") {
      names = patternNames(declaration["id"]);
      effects = true;
    } else return undefined;
    const refs = references(declaration, new Set<string>());
    for (const name of names) refs.delete(name);
    units.push({
      start: isExport ? declaration.start : statement.start,
      end: statement.end,
      names,
      references: refs,
      effects,
    });
    if (isExport) for (const name of names) exported.push([name, name]);
  }
  if (!units.length) return undefined;
  const owner = new Map<string, number>();
  units.forEach((unit, at) => {
    for (const name of unit.names) owner.set(name, at);
  });
  const groups = components(units, owner);
  const pieceOf = new Map<number, number>();
  groups.forEach((group, at) => {
    for (const member of group) pieceOf.set(member, at);
  });
  const pieces: Piece[] = groups.map((group) => {
    const members = group.flatMap((at) => (units[at] ? [units[at]] : []));
    return { units: members, effects: members.some((unit) => unit.effects) };
  });
  const pieceId = (at: number) => `${path}?ace-piece=${at}`;
  const sources = pieces.map((piece, at) => {
    const declared = new Set(piece.units.flatMap((unit) => unit.names));
    const header: string[] = [];
    const siblings = new Map<number, string[]>();
    const used = new Set(piece.units.flatMap((unit) => [...unit.references]));
    for (const name of used) {
      if (declared.has(name)) continue;
      const unit = owner.get(name);
      if (unit !== undefined) {
        const from = pieceOf.get(unit);
        if (from === undefined || from === at) continue;
        siblings.set(from, [...(siblings.get(from) ?? []), name]);
        continue;
      }
      const binding = imports.get(name);
      if (binding) header.push(importOf(name, binding));
    }
    for (const [from, names] of siblings)
      header.push(`import { ${names.join(", ")} } from ${specifier(pieceId(from))};`);
    const body = piece.units.map((unit) => code.slice(unit.start, unit.end)).join("\n");
    return `${header.join("\n")}\n${body}\nexport { ${[...declared].join(", ")} };\n`;
  });
  for (const [name, local] of exported) {
    const unit = owner.get(local);
    const from = unit === undefined ? undefined : pieceOf.get(unit);
    if (from !== undefined) {
      facade.push(
        `export { ${local === name ? name : `${local} as ${name}`} } from ${specifier(pieceId(from))};`,
      );
      continue;
    }
    const binding = imports.get(local);
    if (!binding) return undefined;
    facade.push(
      binding.imported === "*"
        ? `export * as ${name} from ${specifier(binding.source)};`
        : `export { ${binding.imported === name ? name : `${binding.imported} as ${name}`} } from ${specifier(binding.source)};`,
    );
  }
  pieces.forEach((piece, at) => {
    if (piece.effects) facade.push(`import ${specifier(pieceId(at))};`);
  });
  return {
    facade: `${facade.join("\n")}\n`,
    pieces: sources,
    effects: pieces.map((p) => p.effects),
  };
}

/**
 * Worker builds (ADR 0056): a bundler places code by module, so a core protocol module that
 * also defines a service schema brought that schema, and every module it imports, into the
 * worker's startup chunk even though only the lazily loaded service wire reads it. Splitting
 * each protocol module into one module per declaration lets each schema sit in the chunk that
 * first needs it. Protocol modules hold only schema declarations whose construction has no
 * observable effect (`zodPureSchemas`); a declaration that might keep running when its module
 * loads, as before; a module holding anything else is left whole.
 */
export function protocolPieces(): Plugin {
  const splits = new Map<string, Split>();
  return {
    name: "ace:protocol-pieces",
    apply: "build",
    resolveId(source) {
      const match = pieceQuery.exec(source);
      if (!match) return null;
      const split = splits.get(pieceModule(source));
      return { id: source, moduleSideEffects: split?.effects[Number(match[1])] ?? true };
    },
    load(id) {
      const match = pieceQuery.exec(id);
      if (!match) return null;
      const source = splits.get(pieceModule(id))?.pieces[Number(match[1])];
      if (source === undefined) throw new Error(`Unknown protocol piece ${id}`);
      return { code: source, map: null };
    },
    transform(code, id) {
      if (!protocolModule.test(id)) return null;
      const split = splitModule(code, this.parse(code), id);
      if (!split) return null;
      splits.set(id, split);
      return { code: split.facade, map: null };
    },
  };
}
