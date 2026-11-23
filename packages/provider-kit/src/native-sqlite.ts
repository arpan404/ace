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
  bind(params: unknown[]): void;
  stepRows(limit: number): Rows;
  run(): number[];
  reset(): void;
}
interface AddonDatabase {
  exec(sql: string): void;
  prepare(sql: string): AddonStatement;
  isTransaction(): boolean;
  location(): string | null;
  isOpen(): boolean;
  close(): void;
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
/** The addon's failure as the error node:sqlite throws for it. */
function rethrow(error: unknown): never {
  if (!(error instanceof Error) || !error.message.startsWith(prefix)) throw error;
  const failure = JSON.parse(error.message.slice(prefix.length)) as {
    kind: string;
    errcode: number;
    message: string;
    errstr: string;
  };
  switch (failure.kind) {
    case "sqlite":
      throw new SqliteError(failure.message, "ERR_SQLITE_ERROR", failure.errcode, failure.errstr);
    case "range":
      throw new SqliteError(failure.message, "ERR_OUT_OF_RANGE");
    case "no-statement":
      throw new SqliteError(failure.message, "ERR_INVALID_ARG_VALUE");
    default:
      throw new SqliteError(failure.message, "ERR_INVALID_STATE");
  }
}

function call<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    rethrow(error);
  }
}

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

/** Rows stepped per call into the addon while iterating. */
const iterateBatch = 64;

export class NativeStatementSync {
  readonly #statement: AddonStatement;
  #names: (string | null)[] | undefined;
  #columns: string[] | undefined;
  constructor(statement: AddonStatement) {
    this.#statement = statement;
  }
  #bind(args: unknown[]): void {
    const names = (this.#names ??= call(() => this.#statement.parameterNames()));
    const params: Param[] = Array.from({ length: names.length }, () => null);
    let start = 0;
    const named = args[0];
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
    call(() => this.#statement.bind(params));
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
  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    this.#bind(args);
    const [changes = 0, lastInsertRowid = 0] = call(() => this.#statement.run());
    return { changes, lastInsertRowid };
  }
  get(...args: unknown[]): Record<string, unknown> | undefined {
    this.#bind(args);
    const rows = call(() => this.#statement.stepRows(1));
    if (!rows.done) call(() => this.#statement.reset());
    return this.#rows(rows.cells)[0];
  }
  all(...args: unknown[]): Record<string, unknown>[] {
    this.#bind(args);
    const rows: Record<string, unknown>[] = [];
    for (;;) {
      const batch = call(() => this.#statement.stepRows(1024));
      for (const row of this.#rows(batch.cells)) rows.push(row);
      if (batch.done) return rows;
    }
  }
  iterate(...args: unknown[]): IterableIterator<Record<string, unknown>> {
    this.#bind(args);
    const statement = this.#statement;
    let pending: Record<string, unknown>[] = [];
    let index = 0;
    let done = false;
    const iterator: IterableIterator<Record<string, unknown>> = {
      next: () => {
        if (index >= pending.length && !done) {
          const batch = call(() => statement.stepRows(iterateBatch));
          pending = this.#rows(batch.cells);
          index = 0;
          done = batch.done;
        }
        if (index < pending.length) return { done: false, value: pending[index++] as never };
        done = true;
        return { done: true, value: undefined };
      },
      return: (value?: unknown) => {
        if (!done) call(() => statement.reset());
        done = true;
        pending = [];
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
  readOnly?: boolean;
  timeout?: number;
  open?: boolean;
}

export class NativeDatabaseSync {
  readonly #database: AddonDatabase;
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
    return this.#database.isOpen();
  }
  get isTransaction(): boolean {
    return call(() => this.#database.isTransaction());
  }
  exec(sql: string): void {
    call(() => this.#database.exec(sql));
  }
  prepare(sql: string): NativeStatementSync {
    return new NativeStatementSync(call(() => this.#database.prepare(sql)));
  }
  location(): string | null {
    return call(() => this.#database.location());
  }
  close(): void {
    call(() => this.#database.close());
  }
  [Symbol.dispose](): void {
    if (this.#database.isOpen()) this.close();
  }
}
