// SPDX-License-Identifier: Apache-2.0

/*
 * Generates `native/daemon/crates/ace-store/src/schema/steps.rs`: the event database's schema
 * steps, its upgrade floor and the thread columns every database must have. `migrations.ts` stays
 * the one source, so a home written by `ace-daemon-bin` is the home the Bun daemon writes, and
 * either daemon opens the other's (ADR 0226 §8's cross-mode gate). The output is committed, never
 * hand-edited, and `bun run check:daemon-native` regenerates it and fails on a diff.
 *
 *   bun scripts/generate-rust-schema.ts [--check]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrations, threadMetadataColumns, UPGRADE_FLOOR } from "../apps/daemon/src/migrations.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A Rust raw string holding `value`, with enough hashes that its own text cannot end it. */
function raw(value: string): string {
  let hashes = 1;
  while (value.includes(`"${"#".repeat(hashes)}`)) hashes++;
  const fence = "#".repeat(hashes);
  return `r${fence}"${value}"${fence}`;
}

function generate(): string {
  const steps = migrations.map((step, index) => `    // ${index + 1}\n    ${raw(step)},`);
  return `// SPDX-License-Identifier: Apache-2.0
// Generated from apps/daemon/src/migrations.ts by scripts/generate-rust-schema.ts.
// Do not edit: run \`bun scripts/generate-rust-schema.ts\`.

/// The oldest schema an existing database is upgraded from (\`migrations.ts\`'s \`UPGRADE_FLOOR\`).
pub const UPGRADE_FLOOR: i64 = ${UPGRADE_FLOOR};

/// Every step, in order; a database at version N has run steps 1 to N.
pub const MIGRATIONS: &[&str] = &[
${steps.join("\n")}
];

/// The threads columns \`migrations.ts\` requires after every step has run, comma-separated.
/// (One line, so \`cargo fmt\` and this generator agree on the file's shape.)
pub const THREAD_METADATA_COLUMNS: &str = ${raw(threadMetadataColumns.join(","))};
`;
}

const target = join(root, "native", "daemon", "crates", "ace-store", "src", "schema", "steps.rs");
const generated = generate();
if (process.argv.includes("--check")) {
  let committed: string;
  try {
    committed = readFileSync(target, "utf8");
  } catch {
    throw new Error(`${target} is missing; run bun scripts/generate-rust-schema.ts`);
  }
  if (generated !== committed)
    throw new Error(`${target} is stale; run bun scripts/generate-rust-schema.ts`);
  console.log("schema/steps.rs is fresh");
} else {
  writeFileSync(target, generated);
  console.log(`wrote ${target}`);
}
