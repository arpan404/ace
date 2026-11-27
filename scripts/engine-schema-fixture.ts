// SPDX-License-Identifier: Apache-2.0
/**
 * Writes the engine schema fixture (`engine-schema.json`) from a TypeScript-opened home, on a
 * temp file only: never `~/.ace`. The Rust opener's test replays the `base` rows into an empty
 * database, runs `ace-engine::open`, and requires its `sqlite_master` to equal `opened`.
 *
 * `bun scripts/engine-schema-fixture.ts`
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../apps/daemon/src/store.ts";
import { RestartCaptures } from "../apps/daemon/src/engine/restart-captures.ts";
import { openEngineData } from "../apps/daemon/src/native-engine/open.ts";

const dir = mkdtempSync(join(tmpdir(), "ace-engine-schema-"));
const basePath = join(dir, "base.db");
const openedPath = join(dir, "opened.db");

const base = new Store(basePath);
base.close();

const opened = new Store(openedPath);
openEngineData(opened, {}, () => 0);
// E5.8 creates this ledger in `Engine::new`; the Rust opener owns it now.
new RestartCaptures(opened);
opened.close();

function dump(path: string): { type: string; name: string; tbl_name: string; sql: string }[] {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY rowid",
      )
      .all() as { type: string; name: string; tbl_name: string; sql: string }[];
  } finally {
    db.close();
  }
}

const fixture = { base: dump(basePath), opened: dump(openedPath) };
if (fixture.base.length === 0 || fixture.opened.length <= fixture.base.length)
  throw new Error("the TypeScript opener left no schema to compare");
writeFileSync(
  new URL(
    "../native/daemon/crates/ace-engine/tests/fixtures/engine-schema.json",
    import.meta.url,
  ),
  `${JSON.stringify(fixture)}\n`,
);
console.log(`engine-schema.json: ${fixture.base.length} base rows, ${fixture.opened.length} opened`);
