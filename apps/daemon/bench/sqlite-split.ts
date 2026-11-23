/**
 * Splits a measured call's wall time into the time spent inside node:sqlite statements (SQLite
 * stepping plus building the row objects), inside `JSON.parse`, and everything else (schema
 * validation, shaping, copying, freezing). Installed by `sqlite-store.ts --split` only: the
 * wrappers cost about a microsecond per call, which the `other` share absorbs.
 */
import { performance } from "node:perf_hooks";
import { DatabaseSync, StatementSync } from "node:sqlite";

let sqlMs = 0;
let jsonMs = 0;
let statements = 0;
let rows = 0;
let depth = 0;

function timed<A extends unknown[], R>(run: (...args: A) => R, count?: (result: R) => void) {
  return function (this: unknown, ...args: A): R {
    if (depth) return run.apply(this, args);
    depth++;
    const start = performance.now();
    try {
      const result = run.apply(this, args);
      count?.(result);
      return result;
    } finally {
      sqlMs += performance.now() - start;
      depth--;
    }
  };
}

let installed = false;
/** Wrap node:sqlite and JSON.parse for the rest of the process. */
export function installSplit(): void {
  if (installed) return;
  installed = true;
  const statement = StatementSync.prototype;
  const all = statement.all;
  const get = statement.get;
  const run = statement.run;
  const iterate = statement.iterate;
  statement.all = timed(all, (result) => {
    statements++;
    rows += Array.isArray(result) ? result.length : 0;
  }) as typeof all;
  statement.get = timed(get, () => statements++) as typeof get;
  statement.run = timed(run, () => statements++) as typeof run;
  statement.iterate = function (this: StatementSync, ...args: Parameters<typeof iterate>) {
    statements++;
    const iterator = timed(iterate).apply(this, args);
    const next = iterator.next.bind(iterator);
    iterator.next = timed(next, (step) => {
      if (!step.done) rows++;
    }) as typeof iterator.next;
    return iterator;
  } as typeof iterate;
  const database = DatabaseSync.prototype;
  database.exec = timed(database.exec, () => statements++);
  database.prepare = timed(database.prepare);
  const parse = JSON.parse;
  JSON.parse = function (this: unknown, text: string, reviver?: Parameters<typeof parse>[1]) {
    const start = performance.now();
    try {
      return parse.call(JSON, text, reviver);
    } finally {
      jsonMs += performance.now() - start;
    }
  } as typeof JSON.parse;
}

export interface Split {
  wallMs: number;
  sqlMs: number;
  jsonMs: number;
  otherMs: number;
  statements: number;
  rows: number;
}
/** Run `work` and split its wall time; nested calls attribute to the outermost wrapper. */
export function split<T>(work: () => T): [T, Split] {
  const before = { sqlMs, jsonMs, statements, rows };
  const start = performance.now();
  const result = work();
  const wallMs = performance.now() - start;
  const s = sqlMs - before.sqlMs;
  const j = jsonMs - before.jsonMs;
  return [
    result,
    {
      wallMs,
      sqlMs: s,
      jsonMs: j,
      otherMs: Math.max(0, wallMs - s - j),
      statements: statements - before.statements,
      rows: rows - before.rows,
    },
  ];
}

/** Sum of splits, rounded, with each share as a percentage of wall time. */
export function summarize(splits: Split[]) {
  const total = { wallMs: 0, sqlMs: 0, jsonMs: 0, otherMs: 0, statements: 0, rows: 0 };
  for (const one of splits)
    for (const key of Object.keys(total) as (keyof Split)[]) total[key] += one[key];
  const pct = (part: number) => (total.wallMs ? Math.round((part / total.wallMs) * 100) : 0);
  return {
    calls: splits.length,
    wallMs: +total.wallMs.toFixed(1),
    sqlPct: pct(total.sqlMs),
    jsonPct: pct(total.jsonMs),
    otherPct: pct(total.otherMs),
    statementsPerCall: Math.round(total.statements / Math.max(1, splits.length)),
    rowsPerCall: Math.round(total.rows / Math.max(1, splits.length)),
  };
}
