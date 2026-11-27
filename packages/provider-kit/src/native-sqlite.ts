/**
 * node:sqlite's `DatabaseSync` and `StatementSync`, served by the daemon's Rust core
 * (`native/daemon`, ADR 0222). With `ACE_STORE=native` every connection the daemon opens
 * through `@ace/provider-kit/sqlite` is one of these, so one SQLite library holds every lock on
 * a file in the process. Rows, values, parameters and errors behave as node:sqlite's do: rows
 * are null-prototype objects, numbers bind as REAL and BigInts as INTEGER, booleans and
 * `undefined` are refused, failures carry `code`, `errcode` and `errstr`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Rows {
  cells: unknown[];
  done: boolean;
}
interface AddonStatement {
  parameterNames(): (string | null)[];
  columns(): string[];
  stepRows(params: unknown[] | null, limit: number): Rows;
  run(params: unknown[]): number[];
  reset(): void;
}
interface AddonDatabase {
  exec(sql: string): void;
  prepare(sql: string): AddonStatement;
  isTransaction(): boolean;
  location(): string | null;
  isOpen(): boolean;
  close(): void;
  backup(path: string): number;
}
interface Addon {
  NativeDatabase: new (path: string, readOnly: boolean, timeoutMs: number) => AddonDatabase;
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

/** The addon: `ACE_STORE_ADDON`, else the development build in `native/daemon`. */
function addonPath(): string {
  const explicit = process.env.ACE_STORE_ADDON;
  if (explicit) return explicit;
  return fileURLToPath(
    new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
  );
}

let loaded: Addon | undefined;
function addon(): Addon {
  if (loaded) return loaded;
  const path = addonPath();
  // Never fall back to node:sqlite: a run with the switch on must prove the native path.
  if (!existsSync(path))
    throw new Error(
      `ACE_STORE=native needs the store addon at ${path}; build it with cargo build --release in native/daemon`,
    );
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  // Trusted: the addon this tree built, exporting the classes `ace-daemon-node` declares.
  loaded = module.exports as unknown as Addon;
  return loaded;
}

class SqliteError extends Error {
  code: string;
  errcode?: number;
  errstr?: string;
  constructor(message: string, code: string, errcode?: number, errstr?: string) {
    super(message);
    this.code = code;
    if (errcode !== undefined) this.errcode = errcode;
    if (errstr !== undefined) this.errstr = errstr;
  }
}

const prefix = "ace-store:";
/** A failure the addon serialises after `ace-store:` (`ace-daemon-node`'s `failure`). */
export interface NativeSqliteFailure {
  kind: string;
  errcode: number;
  message: string;
  errstr: string;
}

/**
 * The error node:sqlite throws for an addon failure. `Finish` carries these as data, so the
 * shell builds the same error without a throw; `rethrow` uses it too.
 */
export function sqliteError(failure: NativeSqliteFailure): Error {
  switch (failure.kind) {
    case "sqlite":
      return new SqliteError(failure.message, "ERR_SQLITE_ERROR", failure.errcode, failure.errstr);
    case "range":
      return new SqliteError(failure.message, "ERR_OUT_OF_RANGE");
    case "no-statement":
      return new SqliteError(failure.message, "ERR_INVALID_ARG_VALUE");
    default:
      return new SqliteError(failure.message, "ERR_INVALID_STATE");
  }
}

/** The addon's failure as the error node:sqlite throws for it. */
function rethrow(error: unknown): never {
  if (!(error instanceof Error) || !error.message.startsWith(prefix)) throw error;
  throw sqliteError(JSON.parse(error.message.slice(prefix.length)) as NativeSqliteFailure);
}

function call<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    rethrow(error);
  }
}

/**
 * Every shell call into the addon goes through this, so SQLite failures throw
 * as node:sqlite throws them (rule 11). Writer failures that are not SQLite's
 * throw a plain `Error` with the TypeScript's message and pass through here.
 */
export const nativeCall = call;

type Param = null | number | bigint | string | Uint8Array;
function bindable(value: unknown, index: number): Param {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  )
    return value;
  throw new SqliteError(
    `Provided value cannot be bound to SQLite parameter ${index}.`,
    "ERR_INVALID_ARG_TYPE",
  );
}
function isNamed(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    !ArrayBuffer.isView(value)
  );
}

const finalized = () => new SqliteError("statement has been finalized", "ERR_INVALID_STATE");
const invalidated = () => new SqliteError("iterator was invalidated", "ERR_INVALID_STATE");

/** Rows stepped per call into the addon while iterating. */
const iterateBatch = 64;

export class NativeStatementSync {
  readonly #statement: AddonStatement;
  #names: (string | null)[] | undefined;
  #columns: string[] | undefined;
  #generation = 0;
  readonly #open: () => boolean;
  constructor(statement: AddonStatement, open: () => boolean) {
    this.#statement = statement;
    this.#open = open;
  }
  /** The parameters by index, as node:sqlite binds `args`. */
  #params(args: unknown[]): Param[] {
    const names = (this.#names ??= call(() => this.#statement.parameterNames()));
    const named = args[0];
    // Most statements take positional values only: they bind in order, nothing to look up.
    if (!isNamed(named) && names.every((name) => name === null || name.startsWith("?"))) {
      const params: Param[] = Array.from(
        { length: Math.max(names.length, args.length) },
        () => null,
      );
      for (let i = 0; i < args.length; i++) params[i] = bindable(args[i], i + 1);
      return params;
    }
    const params: Param[] = Array.from({ length: names.length }, () => null);
    let start = 0;
    if (isNamed(named)) {
      start = 1;
      for (const [key, value] of Object.entries(named)) {
        const bare = !/^[$:@?]/.test(key);
        const index = names.findIndex((name) =>
          bare ? name !== null && name.slice(1) === key && !name.startsWith("?") : name === key,
        );
        if (index < 0)
          throw new SqliteError(`Unknown named parameter '${key}'`, "ERR_INVALID_STATE");
        params[index] = bindable(value, index + 1);
      }
    }
    // Positional values fill anonymous and numbered parameters in order, as node:sqlite does.
    let slot = 0;
    for (let i = start; i < args.length; i++) {
      while (slot < names.length && names[slot] !== null && !names[slot]?.startsWith("?")) slot++;
      params[slot] = bindable(args[i], slot + 1);
      slot++;
    }
    return params;
  }
  #rows(cells: unknown[]): Record<string, unknown>[] {
    const columns = (this.#columns ??= call(() => this.#statement.columns()));
    const width = columns.length;
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; offset < cells.length; offset += width) {
      const row: Record<string, unknown> = Object.create(null);
      for (let i = 0; i < width; i++) row[columns[i] as string] = cells[offset + i];
      rows.push(row);
    }
    return rows;
  }
  /**
   * Every use of the statement resets it, so it starts a new generation: an iterator from an
   * earlier one throws, as node:sqlite's does, instead of stepping someone else's results.
   */
  #begin(): number {
    if (!this.#open()) throw finalized();
    return ++this.#generation;
  }
  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    this.#begin();
    const params = this.#params(args);
    const [changes = 0, lastInsertRowid = 0] = call(() => this.#statement.run(params));
    return { changes, lastInsertRowid };
  }
  get(...args: unknown[]): Record<string, unknown> | undefined {
    this.#begin();
    const params = this.#params(args);
    const rows = call(() => this.#statement.stepRows(params, 1));
    // A statement stopped after its first row finishes at reset; a RETURNING write commits
    // there, and a failed commit is this call's failure (the addon reports reset's result).
    if (!rows.done) call(() => this.#statement.reset());
    return this.#rows(rows.cells)[0];
  }
  all(...args: unknown[]): Record<string, unknown>[] {
    this.#begin();
    let params: Param[] | null = this.#params(args);
    const rows: Record<string, unknown>[] = [];
    for (;;) {
      const batch = call(() => this.#statement.stepRows(params, 1024));
      params = null;
      for (const row of this.#rows(batch.cells)) rows.push(row);
      if (batch.done) return rows;
    }
  }
  iterate(...args: unknown[]): IterableIterator<Record<string, unknown>> {
    const generation = this.#begin();
    // Bound now, as node:sqlite binds at iterate(); rows are stepped as they are asked for.
    call(() => this.#statement.stepRows(this.#params(args), 0));
    const statement = this.#statement;
    let pending: Record<string, unknown>[] = [];
    let index = 0;
    let done = false;
    const finish = () => {
      done = true;
      pending = [];
    };
    const iterator: IterableIterator<Record<string, unknown>> = {
      next: () => {
        if (!this.#open()) throw finalized();
        if (generation !== this.#generation) throw invalidated();
        if (index >= pending.length && !done) {
          let batch: Rows;
          try {
            batch = call(() => statement.stepRows(null, iterateBatch));
          } catch (error) {
            // The addon reset the statement on its failure: nothing stays held.
            finish();
            throw error;
          }
          pending = this.#rows(batch.cells);
          index = 0;
          done = batch.done;
        }
        if (index < pending.length) return { done: false, value: pending[index++] as never };
        finish();
        return { done: true, value: undefined };
      },
      return: (value?: unknown) => {
        // Release the read snapshot an unfinished iteration holds, unless a later use did.
        const holding = !done && generation === this.#generation && this.#open();
        finish();
        if (holding) call(() => statement.reset());
        return { done: true, value: value as never };
      },
      [Symbol.iterator]() {
        return iterator;
      },
    };
    return iterator;
  }
  columns(): { name: string }[] {
    return (this.#columns ??= call(() => this.#statement.columns())).map((name) => ({ name }));
  }
  setReadBigInts(): void {
    throw new Error("setReadBigInts is not supported by the native store");
  }
  setReturnArrays(): void {
    throw new Error("setReturnArrays is not supported by the native store");
  }
}

export interface NativeDatabaseOptions {
  readOnly?: boolean | undefined;
  timeout?: number | undefined;
  open?: boolean | undefined;
}

/** The addon's handle for a native connection, for the native read bindings; else undefined. */
export function nativeHandle(database: object): object | undefined {
  return database instanceof NativeDatabaseSync ? database.handle : undefined;
}

export class NativeDatabaseSync {
  readonly #database: AddonDatabase;
  /** Kept here so a statement's use checks it without a call into the addon. */
  #open = true;
  constructor(path: string | Buffer | URL, options: NativeDatabaseOptions = {}) {
    if (options.open === false)
      throw new Error("Deferred open is not supported by the native store");
    const file =
      path instanceof URL ? fileURLToPath(path) : typeof path === "string" ? path : String(path);
    const { NativeDatabase } = addon();
    this.#database = call(
      () => new NativeDatabase(file, options.readOnly === true, options.timeout ?? 0),
    );
  }
  get isOpen(): boolean {
    return this.#open;
  }
  /** The addon's `NativeDatabase`, passed to native read bindings as `&NativeDatabase`. */
  get handle(): object {
    return this.#database;
  }
  get isTransaction(): boolean {
    return call(() => this.#database.isTransaction());
  }
  exec(sql: string): void {
    call(() => this.#database.exec(sql));
  }
  prepare(sql: string): NativeStatementSync {
    return new NativeStatementSync(
      call(() => this.#database.prepare(sql)),
      () => this.#open,
    );
  }
  location(): string | null {
    return call(() => this.#database.location());
  }
  close(): void {
    // Closed from here on even if SQLite's close reports a failure: its statements are gone.
    this.#open = false;
    call(() => this.#database.close());
  }
  /** node:sqlite's `backup(db, path)`, copying the whole database at once. */
  backup(path: string | Buffer | URL): Promise<number> {
    const file =
      path instanceof URL ? fileURLToPath(path) : typeof path === "string" ? path : String(path);
    try {
      return Promise.resolve(call(() => this.#database.backup(file)));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  [Symbol.dispose](): void {
    if (this.#open) this.close();
  }
}
