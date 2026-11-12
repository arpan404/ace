import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { build, type Plugin, type Rolldown } from "vite";
import { pieceModule, protocolPieces } from "./protocol-pieces.ts";

const protocol = join(import.meta.dirname, "../../packages/protocol/src");
const entry = join(import.meta.dirname, "pieces-fixture-entry.ts");

/** Builds `entry` over fixture modules placed where protocol modules live, and runs it. */
async function run(files: Record<string, string>, entrySource: string, plugins: Plugin[]) {
  const paths = new Map(
    Object.entries(files).map(([name, source]) => [join(protocol, name), source]),
  );
  const fixture: Plugin = {
    name: "pieces-fixture",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === entry) return entry;
      if (!importer) return null;
      const path = resolve(dirname(pieceModule(importer)), source);
      return paths.has(path) ? path : null;
    },
    load(id) {
      if (id === entry) return entrySource;
      return paths.get(id) ?? null;
    },
  };
  const result = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [fixture, ...plugins],
    build: { write: false, minify: false, lib: { entry, formats: ["es"] } },
  });
  const chunks = (Array.isArray(result) ? result : [result])
    .flatMap((output) => (output as Rolldown.RolldownOutput).output)
    .filter((chunk) => chunk.type === "chunk");
  const start = chunks.find((chunk) => chunk.isEntry);
  if (!start) throw new Error("No entry chunk");
  const out = mkdtempSync(join(tmpdir(), "ace-pieces-"));
  try {
    for (const chunk of chunks) writeFileSync(join(out, chunk.fileName), chunk.code);
    const value = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const { report } = await import(process.argv[1]); process.stdout.write(JSON.stringify(await report()));",
        pathToFileURL(join(out, start.fileName)).href,
      ],
      { encoding: "utf8" },
    );
    // What loads before the entry runs: it and every chunk it imports statically.
    const startup = new Set<string>();
    const visit = (file: string) => {
      const chunk = chunks.find((candidate) => candidate.fileName === file);
      if (!chunk || startup.has(file)) return;
      startup.add(file);
      for (const imported of chunk.imports) visit(imported);
    };
    visit(start.fileName);
    const code = (eager: boolean) =>
      chunks
        .filter((chunk) => startup.has(chunk.fileName) === eager)
        .map((chunk) => chunk.code)
        .join("\n");
    return {
      startup: code(true),
      later: code(false),
      report: JSON.parse(value) as unknown,
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const schemas = {
  "pieces-fixture-ids.ts": `export const Id = { kind: "id" };`,
  "pieces-fixture-core.ts": `
    import { Id } from "./pieces-fixture-ids.ts";
    const shared = { kind: "shared", id: Id };
    export const Core = { kind: "core", shared };
    export const Service = { kind: "service-only-schema", shared };
  `,
  "pieces-fixture-wire.ts": `
    import { Service } from "./pieces-fixture-core.ts";
    export const Wire = { service: Service };
  `,
};
const lazyEntry = `
  import { Core } from "${join(protocol, "pieces-fixture-core.ts")}";
  export async function report() {
    const { Wire } = await import("${join(protocol, "pieces-fixture-wire.ts")}");
    return { core: Core.kind, service: Wire.service.kind, sameShared: Wire.service.shared === Core.shared };
  }
`;

test("a schema only a lazily loaded module reads leaves the startup chunk", async () => {
  const whole = await run(schemas, lazyEntry, []);
  expect(whole.startup).toContain("service-only-schema");
  const split = await run(schemas, lazyEntry, [protocolPieces()]);
  expect(split.startup).not.toContain("service-only-schema");
  expect(split.later).toContain("service-only-schema");
  expect(split.report).toEqual(whole.report);
  expect(split.report).toEqual({ core: "core", service: "service-only-schema", sameShared: true });
});

test("declarations that refer to each other keep evaluating in source order", async () => {
  const files = {
    "pieces-fixture-cycle.ts": `
      export const Node = { get child() { return Tree; }, kind: "node" };
      export const Tree = { root: Node, kind: "tree" };
      export function depth(value) { return value === Tree ? 1 + depth(value.root) : 0; }
    `,
  };
  const source = `
    import { Tree, depth } from "${join(protocol, "pieces-fixture-cycle.ts")}";
    export const report = () => ({ loop: Tree.root.child === Tree, depth: depth(Tree) });
  `;
  const whole = await run(files, source, []);
  const split = await run(files, source, [protocolPieces()]);
  expect(split.report).toEqual(whole.report);
  expect(split.report).toEqual({ loop: true, depth: 1 });
});

test("a declaration whose evaluation can be observed still runs when its module loads", async () => {
  const files = {
    "pieces-fixture-effects.ts": `
      export class Registered { static { (globalThis.ran ??= []).push("class"); } }
      export const Read = { kind: "read" };
    `,
    "pieces-fixture-statement.ts": `
      export const Counted = { kind: "counted" };
      (globalThis.ran ??= []).push("statement");
    `,
  };
  const source = `
    import { Read } from "${join(protocol, "pieces-fixture-effects.ts")}";
    import { Counted } from "${join(protocol, "pieces-fixture-statement.ts")}";
    export const report = () => ({ read: Read.kind, counted: Counted.kind, ran: globalThis.ran });
  `;
  const whole = await run(files, source, []);
  const split = await run(files, source, [protocolPieces()]);
  expect(split.report).toEqual(whole.report);
  expect(split.report).toEqual({ read: "read", counted: "counted", ran: ["class", "statement"] });
});
