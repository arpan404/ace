/*
 * The migration lint for ace cloud's and the market's D1 databases (docs/release/workers.md).
 * A release applies its migrations before its Worker goes live, the old Worker keeps serving
 * until then, and app builds already out in the world keep calling it for months. So a migration
 * may only add: a statement that removes or renames something the running code reads, adds a
 * column old code can't insert into, or deletes or rewrites a whole table is refused unless the
 * file says, with a reason, why it is safe. It reads SQLite tokens (sql-tokens.ts), so quoted
 * names, strings and comments can't hide or fake a statement. Pure: SQL text in, problems out.
 */

import { isWord, statements, tokenize, type Token } from "./sql-tokens.ts";

export const migrationRules = [
  "drop-table",
  "drop-view",
  "drop-column",
  "rename",
  "not-null-without-default",
  "delete-without-where",
  "update-without-where",
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
  "delete-without-where": "deletes every row of a table the running Worker reads",
  "update-without-where": "rewrites every row of a table the running Worker reads",
};

/** The shortest reason an opt-out may give. */
export const minimumReasonLength = 20;

/**
 * `-- migration-lint allow <rule>: <reason>`, a real line comment (not text inside a string or a
 * block comment). One marker per rule; it allows
 * every statement in the file that breaks that rule.
 */
const marker = /^--\s*migration-lint\s+allow\s+([a-z-]+)\s*:?\s*(.*)$/;

function isRule(value: string): value is MigrationRule {
  return (migrationRules as readonly string[]).includes(value);
}

const nameKinds: ReadonlySet<Token["kind"]> = new Set(["word", "quoted", "string"]);

/** The index just past a name, schema-qualified or not, starting at `at`; -1 if none is there. */
function afterName(tokens: readonly Token[], at: number): number {
  if (!nameKinds.has(tokens[at]?.kind ?? "other")) return -1;
  const dot = tokens[at + 1];
  if (dot?.kind === "other" && dot.text === "." && nameKinds.has(tokens[at + 2]?.kind ?? "other"))
    return at + 3;
  return at + 1;
}

/** Each token's index paired with its parenthesis depth, from `from`. */
function* atDepth(tokens: readonly Token[], from: number): Generator<[number, number]> {
  let depth = 0;
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === "other" && token.text === ")") depth -= 1;
    yield [index, depth];
    if (token?.kind === "other" && token.text === "(") depth += 1;
  }
}

const verbs = new Set(["DELETE", "UPDATE", "INSERT", "REPLACE", "SELECT", "VALUES"]);

/** Where the statement's own verb is, past any `WITH …` common table expressions. */
function mainVerb(tokens: readonly Token[]): number {
  if (!isWord(tokens[0], "WITH")) return 0;
  for (const [index, depth] of atDepth(tokens, 1)) {
    const token = tokens[index];
    if (depth === 0 && token?.kind === "word" && verbs.has(token.text)) return index;
  }
  return -1;
}

function alterRules(tokens: readonly Token[]): MigrationRule[] {
  const at = afterName(tokens, 2);
  const action = tokens[at];
  if (isWord(action, "DROP")) return ["drop-column"];
  if (isWord(action, "RENAME")) return ["rename"];
  if (!isWord(action, "ADD")) return [];
  const column = tokens.slice(at + 1);
  const notNull = column.some((token, i) => isWord(token, "NOT") && isWord(column[i + 1], "NULL"));
  const defaulted = column.some((token) => isWord(token, "DEFAULT"));
  return notNull && !defaulted ? ["not-null-without-default"] : [];
}

/** Which rules one statement breaks. */
function brokenRules(tokens: readonly Token[]): MigrationRule[] {
  const [first, second] = tokens;
  if (isWord(first, "DROP") && isWord(second, "TABLE")) return ["drop-table"];
  if (isWord(first, "DROP") && isWord(second, "VIEW")) return ["drop-view"];
  if (isWord(first, "ALTER") && isWord(second, "TABLE")) return alterRules(tokens);
  // A trigger's DELETE or UPDATE runs per row later, not over the table now.
  if (isWord(first, "CREATE")) return [];
  const verb = mainVerb(tokens);
  const isDelete = isWord(tokens[verb], "DELETE");
  if (!isDelete && !isWord(tokens[verb], "UPDATE")) return [];
  for (const [index, depth] of atDepth(tokens, verb + 1))
    if (depth === 0 && isWord(tokens[index], "WHERE")) return [];
  return [isDelete ? "delete-without-where" : "update-without-where"];
}

interface OptOut {
  line: number;
  reason: string;
}

function optOuts(file: string, comments: readonly Token[], problems: MigrationProblem[]) {
  const allowed = new Map<MigrationRule, OptOut>();
  for (const comment of comments) {
    const match = marker.exec(comment.text);
    if (!match) continue;
    const [, rule = "", reason = ""] = match;
    const line = comment.line;
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
  }
  return allowed;
}

/** Every problem in one migration file. */
export function lintMigration(file: string, sql: string): MigrationProblem[] {
  const problems: MigrationProblem[] = [];
  const tokens = tokenize(sql);
  const comments = tokens.filter((token) => token.kind === "comment");
  const allowed = optOuts(file, comments, problems);
  const used = new Set<MigrationRule>();
  for (const statement of statements(tokens)) {
    for (const rule of brokenRules(statement.tokens)) {
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
  return problems.toSorted((a, b) => a.line - b.line);
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
