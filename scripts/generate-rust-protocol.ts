// SPDX-License-Identifier: Apache-2.0

/*
 * Generates `native/daemon/crates/ace-protocol/src/generated.rs` from the
 * JSON Schema of the `@ace/protocol` schemas the engine uses
 * (`z.toJSONSchema`) via `typify` (ADR 0223 §2). `packages/protocol` stays
 * the one source of truth: the output is committed, never hand-edited, and
 * `check:daemon-native` regenerates and fails on a diff.
 *
 *   bun scripts/generate-rust-protocol.ts [--check]
 *
 * `--check` regenerates to a temporary file and fails naming it when it
 * differs from the committed output. Each root below is a schema the engine
 * reads or writes (ADR 0223 §2 names the set); shared schemas referenced
 * from several roots become one `$defs` entry (`reused: "ref"`), titled so
 * `typify` emits one Rust type per shared schema instead of a copy per use.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AccessMode,
  AcpIdentity,
  AcpSessionSupport,
  AgentItem,
  AgentStatus,
  Capabilities,
  CatalogModel,
  Command,
  CommandPayload,
  ContentPart,
  EffortLevel,
  Event,
  EventPayload,
  ExecutionOptions,
  ExecutionSelection,
  GoalChange,
  InteractionResolution,
  KnownThreadStatus,
  MessageOrigin,
  ModelEffort,
  ModelSource,
  ModelTier,
  PermissionMode,
  ProviderKind,
  ScreenKey,
  ThreadId,
  ThreadStatus,
  ThreadClientFields,
  ThreadDetails,
  ThreadProviderMetadata,
} from "@ace/protocol";
import { shapesSource } from "./rust-protocol-shapes.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The schemas the engine reads and writes, each emitted as one Rust type. */
const roots: Record<string, z.ZodType> = {
  EventPayload,
  Event,
  AgentItem,
  ContentPart,
  MessageOrigin,
  AgentStatus,
  KnownThreadStatus,
  ThreadStatus,
  CommandPayload,
  Command,
  GoalChange,
  InteractionResolution,
  ExecutionOptions,
  ExecutionSelection,
  Capabilities,
  PermissionMode,
  AcpIdentity,
  AcpSessionSupport,
  AccessMode,
  ProviderKind,
  CatalogModel,
  CatalogRaw: CatalogModel.shape.raw,
  ModelEffort,
  ModelTier,
  ModelSource,
  EffortLevel,
  ThreadId,
};

const combined = z.object(roots as Record<string, z.ZodType>);
const rawSchema = z.toJSONSchema(combined, {
  unrepresentable: "any",
  io: "output",
  reused: "ref",
  override: ({ zodSchema, jsonSchema }) => {
    if (zodSchema === ScreenKey) {
      // `typify` cannot name this enum's variants (`A` and `a` sanitize
      // alike), so the Rust form stays an open string, which is also the
      // lenient decoding (rule 8): unknown keys stay readable, and the
      // title below only marks the spot (nested titles do not survive
      // typify's merges, so uses read `String`). The closed list lives in
      // `screen-keys.ts`.
      for (const key of Object.keys(jsonSchema)) delete jsonSchema[key as keyof typeof jsonSchema];
      jsonSchema.type = "string";
      jsonSchema.title = "ScreenKey";
      return;
    }
    for (const [name, rootSchema] of Object.entries(roots)) {
      if (zodSchema === rootSchema) {
        jsonSchema.title = name;
        return;
      }
    }
  },
});

/*
 * What `typify` cannot turn into Rust types is dropped before generation.
 * None of it changes a Rust type: `serde` does not enforce lengths,
 * patterns or formats, so the TypeScript's runtime-only checks have no
 * structural counterpart. Kept: `const` and `enum`, which choose variants.
 * - `minLength`, `maxLength`, `pattern`: typify makes a validated newtype
 *   that needs a name for every inline use and a `regress` dependency for
 *   patterns; an inline constrained string inside an enum variant panics.
 * - `format`: typify maps unknown formats (`ace-whatwg-url`) the same
 *   constrained way, and known ones to non-`String` natives.
 * - `propertyNames`: a merge assertion in typify rejects it outright; key
 *   constraints have no Rust map counterpart.
 * - `not`: exclusion constraints (`.refine` with a `not` pattern) have no
 *   Rust type counterpart; typify renders them as an empty, uninhabited enum.
 * - `additionalProperties: false`: typify turns it into
 *   `deny_unknown_fields`, which rule 8 forbids. The TypeScript never
 *   enforced it either (`z.object` strips unknown keys at runtime), so the
 *   Rust structs ignore unknown fields exactly like the decoders do today.
 *   Keeping them as raw stays the frame layer's job (`Box<RawValue>`).
 */
function stripValidation(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripValidation(item);
    return;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    delete record.minLength;
    delete record.maxLength;
    delete record.pattern;
    delete record.format;
    delete record.propertyNames;
    delete record.additionalProperties;
    delete record.not;
    for (const value of Object.values(record)) stripValidation(value);
  }
}

function renameTitledDefs(document: unknown): void {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return;
  const defs = (document as Record<string, unknown>).$defs;
  if (defs === null || typeof defs !== "object" || Array.isArray(defs)) return;
  const table = defs as Record<string, unknown>;
  const renamed = new Map<string, string>();
  for (const [key, def] of Object.entries(table)) {
    if (def !== null && typeof def === "object" && !Array.isArray(def)) {
      const title = (def as Record<string, unknown>).title;
      if (typeof title === "string" && title.length > 0 && title !== key) {
        renamed.set(key, title);
        table[title] = def;
        delete table[key];
      }
    }
  }
  if (renamed.size === 0) return;
  const rewrite = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) rewrite(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      const object = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(object)) {
        if (key === "$ref" && typeof value === "string") {
          for (const [from, to] of renamed) {
            if (value === `#/$defs/${from}`) object[key] = `#/$defs/${to}`;
          }
        } else rewrite(value);
      }
    }
  };
  rewrite(document);
}

function isNullBranch(branch: unknown): boolean {
  if (branch === null || typeof branch !== "object" || Array.isArray(branch)) return false;
  const record = branch as Record<string, unknown>;
  if (record.$ref !== undefined) return false;
  if (record.type === "null") return true;
  if (Array.isArray(record.enum) && record.enum.length === 1 && record.enum[0] === null)
    return true;
  return record.const === null;
}

function hoistNullableBranches(document: unknown): void {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return;
  const defs = (document as Record<string, unknown>).$defs;
  if (defs === null || typeof defs !== "object" || Array.isArray(defs)) return;
  const table = defs as Record<string, unknown>;
  for (const [key, def] of Object.entries(table)) {
    if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
    const record = def as Record<string, unknown>;
    for (const combinator of ["anyOf", "oneOf"]) {
      const branches = record[combinator];
      if (!Array.isArray(branches) || branches.length !== 2) continue;
      const [first, second] = branches as unknown[];
      const inner = isNullBranch(first) ? second : isNullBranch(second) ? first : undefined;
      if (
        inner === undefined ||
        inner === null ||
        typeof inner !== "object" ||
        Array.isArray(inner) ||
        (inner as Record<string, unknown>).$ref !== undefined
      )
        continue;
      const innerKey = `${key}Inner`;
      table[innerKey] = inner;
      record[combinator] = (branches as unknown[]).map((branch) =>
        branch === inner ? { $ref: `#/$defs/${innerKey}` } : branch,
      );
    }
  }
}
const schema = JSON.parse(JSON.stringify(rawSchema)) as unknown;
stripValidation(schema);
/*
 * `typify` names `$defs` entries by their key, not their `title`. Point the
 * titled entries at their titles so the Rust types are named for the schema
 * (`ContentPart`, not `__schema128`); untitled entries keep their generated
 * keys. Refs are rewritten to match.
 */
renameTitledDefs(schema);
/*
 * `typify` 0.8 converts a named `$defs` entry shaped `anyOf`/`oneOf` with a
 * null branch by naming both the nullable wrapper and an inline
 * object/enum branch after the entry, so neither compiles. Hoist such a
 * branch into its own entry: the wrapper keeps the entry's name, the branch
 * takes `<entry>Inner`. Semantics do not change; the branch was used once.
 */
hoistNullableBranches(schema);

function runMain(): void {
  const scratchDir = mkdtempSync(join(tmpdir(), "ace-protocol-"));
  try {
    generate(scratchDir);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function channel(): string {
  const toolchain = readFileSync(join(root, "native", "daemon", "rust-toolchain.toml"), "utf8");
  const found = /^channel\s*=\s*"([^"]+)"/m.exec(toolchain)?.[1];
  if (found === undefined) throw new Error("native/daemon/rust-toolchain.toml names no channel");
  return found;
}

/** `cargo` on the workspace's pinned toolchain, like `check:daemon-native` runs it. */
let hasRustup = true;
try {
  execFileSync("rustup", ["--version"], { stdio: "ignore" });
} catch {
  hasRustup = false;
}

function cargo(args: string[], options: object): string {
  const cwd = join(root, "native", "daemon");
  if (hasRustup)
    return execFileSync("rustup", ["run", channel(), "cargo", ...args], {
      cwd,
      ...options,
    }) as string;
  return execFileSync("cargo", args, { cwd, ...options }) as string;
}

function runRustfmt(path: string): void {
  if (hasRustup) execFileSync("rustup", ["run", channel(), "rustfmt", "--edition", "2024", path]);
  else execFileSync("rustfmt", ["--edition", "2024", path]);
}

function generate(scratchDir: string): void {
  const schemaPath = join(scratchDir, "protocol.json");
  writeFileSync(schemaPath, `${JSON.stringify(schema)}\n`);
  const raw = join(scratchDir, "generated.raw.rs");
  const out = cargo(["run", "--quiet", "-p", "ace-protocol-gen", "--", schemaPath], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  // The file is committed and never hand-edited; the header marks it as
  // generated and silences lints inherent to typify's output style: casing
  // from wire values (`-1`, `+1`), infallible conversions it emits as
  // `TryFrom`, newtypes it could derive, and untagged unions whose variants
  // differ in size.
  const header = `// SPDX-License-Identifier: Apache-2.0
// Generated by scripts/generate-rust-protocol.ts -- do not edit.
#![allow(non_camel_case_types)]
#![allow(clippy::derivable_impls)]
#![allow(clippy::infallible_try_from)]
#![allow(clippy::large_enum_variant)]
`;
  writeFileSync(raw, `${header}${out}`);
  // Format with the pinned toolchain's rustfmt, as `cargo fmt` would.
  runRustfmt(raw);
  const generated = join(root, "native", "daemon", "crates", "ace-protocol", "src", "generated.rs");
  const formatted = readFileSync(raw, "utf8");
  if (process.argv.includes("--check")) {
    const committed = readFileSync(generated, "utf8");
    if (formatted !== committed)
      throw new Error(`${generated} is stale; run bun scripts/generate-rust-protocol.ts`);
    console.log("ace-protocol/src/generated.rs is fresh");
  } else {
    writeFileSync(generated, formatted);
    console.log(`wrote ${generated}`);
  }
  // The shape table for the column encoders (porting guide 5.3b): the same schemas, walked by
  // `rust-protocol-shapes.ts` instead of through JSON Schema, because `typify` can't describe
  // Zod's stripping, defaults and key order.
  const shapesDir = join(root, "native", "daemon", "crates", "ace-protocol", "src", "shapes");
  const shapeFiles = shapesSource({
    THREAD_CLIENT_COLUMN: ThreadClientFields.omit({ details: true }),
    THREAD_DETAILS: ThreadDetails,
    THREAD_PROVIDER_METADATA: ThreadProviderMetadata,
  });
  // Write every part first, so rustfmt can resolve `mod` from `mod.rs` in the scratch dir.
  const rawPaths = [...shapeFiles].map(([name, source]) => {
    const path = join(scratchDir, name);
    writeFileSync(path, source);
    return { name, path, target: join(shapesDir, name) };
  });
  for (const { name, path: rawPath, target } of rawPaths) {
    runRustfmt(rawPath);
    const shaped = readFileSync(rawPath, "utf8");
    if (process.argv.includes("--check")) {
      let committed = "";
      try {
        committed = readFileSync(target, "utf8");
      } catch {
        // Missing files are stale too, and the message below names them.
      }
      if (shaped !== committed)
        throw new Error(`${target} is stale; run bun scripts/generate-rust-protocol.ts`);
      console.log(`ace-protocol/src/shapes/${name} is fresh`);
    } else {
      mkdirSync(shapesDir, { recursive: true });
      writeFileSync(target, shaped);
      console.log(`wrote ${target}`);
    }
  }
}

runMain();
