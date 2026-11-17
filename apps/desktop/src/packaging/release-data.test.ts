import { describe, expect, it } from "vitest";
import { renderReleaseData, spadeMigrationCount } from "./release-data.ts";

const schema = (entries: string[]) => `//! The database layout.

struct Migration {
    sql: &'static str,
    backfill: Option<fn(&Transaction<'_>) -> rusqlite::Result<()>>,
}

const MIGRATIONS: &[Migration] = &[
${entries.join("\n")}
];

pub fn current_version() -> usize {
    MIGRATIONS.len()
}
`;
const entry = (sql: string) => `    Migration {
        sql: "${sql}",
        backfill: None,
    },`;

describe("Spade's schema version in a release's data formats", () => {
  it("is the number of migrations in the list, not the struct that defines one", () => {
    expect(spadeMigrationCount(schema([entry("CREATE TABLE a (id)")]))).toBe(1);
    expect(
      spadeMigrationCount(
        schema(["a", "b", "c"].map((name) => entry(`CREATE TABLE ${name} (id)`))),
      ),
    ).toBe(3);
  });

  it("doesn't count a migration's text that happens to mention one", () => {
    const tricky = entry("-- a comment:\n    Migration {\n");
    expect(spadeMigrationCount(schema([entry("CREATE TABLE a (id)"), tricky]))).toBe(2);
  });

  it("refuses a schema it can't read rather than guess a number", () => {
    expect(() => spadeMigrationCount("fn main() {}")).toThrow(/no MIGRATIONS/);
    expect(() => spadeMigrationCount(schema([]))).toThrow(/empty/);
  });
});

describe("ace-data.json", () => {
  it("holds the four numbers, and refuses one that isn't a format number", () => {
    expect(JSON.parse(renderReleaseData({ home: 1, daemon: 63, notify: 5, spade: 9 }))).toEqual({
      home: 1,
      daemon: 63,
      notify: 5,
      spade: 9,
    });
    expect(() => renderReleaseData({ home: 1, daemon: -1, notify: 5, spade: 9 })).toThrow();
  });
});
