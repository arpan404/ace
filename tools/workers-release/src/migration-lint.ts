/*
 * The migration lint for ace cloud's and the market's D1 databases (docs/release/workers.md).
 * A release applies its migrations before its Worker goes live, the old Worker keeps serving
 * until then, and app builds already out in the world keep calling it for months. So a migration
 * may only add: a statement that removes or renames something the running code reads, or adds a
 * column old code can't insert into, is refused unless the file says, with a reason, why it is
 * safe. Pure: SQL text in, problems out.
 */

export const migrationRules = [
  "drop-table",
  "drop-view",
  "drop-column",
  "rename",
  "not-null-without-default",
] as const;
export type MigrationRule = (typeof migrationRules)[number];

export interface MigrationProblem {
  file: string;
  line: number;
  rule: MigrationRule | "opt-out";
  message: string;
}

const explanations: Record<MigrationRule, string> = {
  "drop-table": "drops a table the running Worker or an older one may still read",
  "drop-view": "drops a view the running Worker or an older one may still read",
  "drop-column": "drops a column the running Worker or an older one may still read",
  rename: "renames a table or column out from under the running Worker",
  "not-null-without-default":
    "adds a NOT NULL column without a DEFAULT, so an older Worker's inserts fail",
};

/** The shortest reason an opt-out may give. */
export const minimumReasonLength = 20;

/**
 * `-- migration-lint allow <rule>: <reason>` on a line of its own. One marker per rule; it allows
 * every statement in the file that breaks that rule.
 */
const marker = /^\s*--\s*migration-lint\s+allow\s+([a-z-]+)\s*:?\s*(.*)$/;

function isRule(value: string): value is MigrationRule {
  return (migrationRules as readonly string[]).includes(value);
}

/**
 * The SQL with comments blanked and string literals emptied, each character kept in place (so
 * offsets still map to lines) and newlines kept.
 */
function blankCommentsAndStrings(sql: string): string {
  let out = "";
  let index = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  while (index < sql.length) {
    const rest = sql.slice(index);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", index);
      const stop = end === -1 ? sql.length : end;
      out += blank(sql.slice(index, stop));
      index = stop;
    } else if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += blank(sql.slice(index, stop));
      index = stop;
    } else if (sql[index] === "'") {
      let stop = index + 1;
      while (stop < sql.length) {
        if (sql[stop] === "'" && sql[stop + 1] === "'") stop += 2;
        else if (sql[stop] === "'") break;
        else stop += 1;
      }
      out += `'${blank(sql.slice(index + 1, stop))}'`;
      index = stop + 1;
    } else {
      out += sql[index];
      index += 1;
    }
  }
  return out;
}

interface Statement {
  line: number;
  text: string;
}

function statements(sql: string): Statement[] {
  const cleaned = blankCommentsAndStrings(sql);
  const found: Statement[] = [];
  let start = 0;
  for (const piece of cleaned.split(";")) {
    const lead = piece.length - piece.trimStart().length;
    const text = piece.trim().replace(/\s+/g, " ").toUpperCase();
    if (text) found.push({ line: cleaned.slice(0, start + lead).split("\n").length, text });
    start += piece.length + 1;
  }
  return found;
}

const table = String.raw`(?:IF EXISTS )?(?:"[^"]+"|\[[^\]]+\]|\x60[^\x60]+\x60|[\w.]+)`;
const patterns: [MigrationRule, RegExp][] = [
  ["drop-table", new RegExp(String.raw`^DROP TABLE\b`)],
  ["drop-view", new RegExp(String.raw`^DROP VIEW\b`)],
  ["drop-column", new RegExp(String.raw`^ALTER TABLE ${table} DROP\b`)],
  ["rename", new RegExp(String.raw`^ALTER TABLE ${table} RENAME\b`)],
];
const addColumn = new RegExp(String.raw`^ALTER TABLE ${table} ADD\b`);

/** Which rules one normalized statement breaks. */
function brokenRules(text: string): MigrationRule[] {
  const broken = patterns.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule);
  if (addColumn.test(text) && /\bNOT NULL\b/.test(text) && !/\bDEFAULT\b/.test(text))
    broken.push("not-null-without-default");
  return broken;
}

interface OptOut {
  line: number;
  reason: string;
}

function optOuts(file: string, sql: string, problems: MigrationProblem[]) {
  const allowed = new Map<MigrationRule, OptOut>();
  sql.split("\n").forEach((text, index) => {
    const match = marker.exec(text);
    if (!match) return;
    const [, rule = "", reason = ""] = match;
    const line = index + 1;
    if (!isRule(rule)) {
      problems.push({
        file,
        line,
        rule: "opt-out",
        message: `unknown rule "${rule}"; the rules are ${migrationRules.join(", ")}`,
      });
    } else if (reason.trim().length < minimumReasonLength) {
      problems.push({
        file,
        line,
        rule: "opt-out",
        message: `the opt-out for ${rule} needs a reason of at least ${minimumReasonLength} characters`,
      });
    } else {
      allowed.set(rule, { line, reason: reason.trim() });
    }
  });
  return allowed;
}

/** Every problem in one migration file. */
export function lintMigration(file: string, sql: string): MigrationProblem[] {
  const problems: MigrationProblem[] = [];
  const allowed = optOuts(file, sql, problems);
  const used = new Set<MigrationRule>();
  for (const statement of statements(sql)) {
    for (const rule of brokenRules(statement.text)) {
      if (allowed.has(rule)) {
        used.add(rule);
        continue;
      }
      problems.push({
        file,
        line: statement.line,
        rule,
        message: `${explanations[rule]}. Expand first and contract in a later release, or add "-- migration-lint allow ${rule}: <why it is safe>"`,
      });
    }
  }
  for (const [rule, optOut] of allowed) {
    if (used.has(rule)) continue;
    problems.push({
      file,
      line: optOut.line,
      rule: "opt-out",
      message: `the opt-out for ${rule} allows nothing in this file; remove it`,
    });
  }
  return problems.sort((a, b) => a.line - b.line);
}

/** Every problem in a set of migration files. */
export function lintMigrations(
  files: readonly { file: string; sql: string }[],
): MigrationProblem[] {
  return files.flatMap(({ file, sql }) => lintMigration(file, sql));
}

export function formatProblem(problem: MigrationProblem): string {
  return `${problem.file}:${problem.line}: [${problem.rule}] ${problem.message}`;
}
