import { createRequire } from "node:module";

/**
 * Typed access to Bun's `bun:ffi`, the daemon's way to call C and Win32 functions. No Bun type
 * definitions are installed, so the module is checked at load and every call returns `unknown`
 * for the caller to parse. Importing this file loads nothing: `bun:ffi` is required on first
 * use, so code bundled into processes that are not Bun (the Electron main process) can import
 * it and choose another path before calling it.
 *
 * Bun's argument and return type names: https://bun.com/docs/runtime/ffi
 */
export type FfiType =
  | "void"
  | "bool"
  | "i8"
  | "u8"
  | "i16"
  | "u16"
  | "i32"
  | "u32"
  | "i64"
  | "u64"
  /**
   * 64-bit integers returned as numbers while they fit. Win32 HANDLEs (and HWNDs) use this,
   * never `ptr`: Bun's docs say Windows handles are not pointers it can pass correctly, and
   * INVALID_HANDLE_VALUE (-1) stays -1. See `nativeHandle` and `handleSlot`.
   */
  | "i64_fast"
  | "u64_fast"
  /** A pointer: returned as a number, or null for NULL. Typed arrays and null may be passed. */
  | "ptr";

export interface FfiSymbol {
  readonly args: readonly FfiType[];
  readonly returns: FfiType;
}

/** Numbers, bigints and pointers (numbers); typed arrays and Buffers pass their bytes' address. */
export type FfiArgument = number | bigint | boolean | null | ArrayBufferView;
export type NativeFunction = (...args: FfiArgument[]) => unknown;

export interface NativeLibrary<Name extends string> {
  readonly symbols: Readonly<Record<Name, NativeFunction>>;
  close(): void;
}

interface BunFfi {
  dlopen(path: string, symbols: Record<string, FfiSymbol>): unknown;
  read: {
    u16(pointer: number, offset: number): unknown;
    i32(pointer: number, offset: number): unknown;
  };
  CString: new (pointer: number, offset: number) => unknown;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}
function hasFunctions(value: unknown, names: readonly string[]): boolean {
  return isObject(value) && names.every((name) => typeof Reflect.get(value, name) === "function");
}
function isBunFfi(value: unknown): value is BunFfi {
  return (
    hasFunctions(value, ["dlopen", "CString"]) &&
    isObject(value) &&
    hasFunctions(Reflect.get(value, "read"), ["u16", "i32"])
  );
}

/** Whether this process runs on Bun, where `bun:ffi` exists. */
export function runsOnBun(): boolean {
  return typeof Reflect.get(globalThis, "Bun") === "object";
}

let loaded: BunFfi | undefined;
function ffi(): BunFfi {
  if (loaded) return loaded;
  if (!runsOnBun()) throw new Error("Native calls need Bun's bun:ffi; this process is not Bun");
  const module: unknown = createRequire(import.meta.url)("bun:ffi");
  if (!isBunFfi(module)) throw new Error("bun:ffi is missing dlopen, CString or read");
  loaded = module;
  return module;
}

/**
 * Opens a shared library (a path, or a name the system loader searches for) and binds the
 * named functions. Throws when the library or any function is missing.
 */
export function openLibrary<Name extends string>(
  path: string,
  definitions: Readonly<Record<Name, FfiSymbol>>,
): NativeLibrary<Name> {
  const opened: unknown = ffi().dlopen(path, { ...definitions });
  const close: unknown = isObject(opened) ? Reflect.get(opened, "close") : undefined;
  const bound: unknown = isObject(opened) ? Reflect.get(opened, "symbols") : undefined;
  if (typeof close !== "function" || !isObject(bound))
    throw new Error(`bun:ffi opened ${path} without symbols`);
  const symbols: Partial<Record<Name, NativeFunction>> = {};
  for (const name of Object.keys(definitions) as Name[]) {
    const fn: unknown = Reflect.get(bound, name);
    if (typeof fn !== "function") throw new Error(`${path} has no function ${name}`);
    symbols[name] = (...args) => {
      const result: unknown = Reflect.apply(fn, undefined, args);
      return result;
    };
  }
  return {
    symbols: symbols as Record<Name, NativeFunction>,
    close: () => void Reflect.apply(close, opened, []),
  };
}

/** A NUL-terminated UTF-8 string for a `const char *` argument. */
export function cString(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf8");
}
/** A NUL-terminated UTF-16LE string for a Win32 wide-string (`LPCWSTR`) argument. */
export function wideString(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

/** The NUL-terminated UTF-8 string at `pointer + offset`. */
export function readCString(pointer: number, offset = 0): string {
  return String(new (ffi().CString)(pointer, offset));
}

/** The NUL-terminated UTF-16LE string at `pointer`, at most `limit` code units long. */
export function readWideString(pointer: number, limit = 32_768): string {
  const read = ffi().read;
  const units: number[] = [];
  for (let offset = 0; units.length < limit; offset += 2) {
    const unit = Number(read.u16(pointer, offset));
    if (unit === 0) return String.fromCharCode(...units);
    units.push(unit);
  }
  throw new Error("Native wide string has no terminator within its limit");
}

/** The 32-bit signed integer at `pointer + offset`, such as the calling thread's errno. */
export function readInt32(pointer: number, offset = 0): number {
  return Number(ffi().read.i32(pointer, offset));
}

/**
 * A pointer-sized out-parameter (`void **`, `HANDLE *`). Pass `slot` to the call, then read
 * `value()`: the pointer as a number, or null for NULL.
 */
export function pointerSlot(): { readonly slot: BigUint64Array; value(): number | null } {
  const slot = new BigUint64Array(1);
  return {
    slot,
    value: () => {
      const value = slot[0] ?? 0n;
      return value === 0n ? null : Number(value);
    },
  };
}

/**
 * A Win32 HANDLE held in JS, as an `i64_fast` argument takes it: a number, 0 for NULL. Handles
 * are small kernel table values (or -1), so a number holds them exactly.
 */
export function nativeHandle(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") return Number(BigInt.asIntN(64, value));
  if (value === null || value === undefined) return 0;
  throw new Error("Not a native handle");
}

/** A HANDLE out-parameter (`HANDLE *`): pass `slot`, then read `value()` (0 for NULL). */
export function handleSlot(): { readonly slot: BigInt64Array; value(): number } {
  const slot = new BigInt64Array(1);
  return { slot, value: () => Number(slot[0] ?? 0n) };
}

/**
 * A memory address held in JS, as bun:ffi takes it: a number, or null for NULL. Bigints
 * (pointers read out of a struct) become numbers; user-space addresses fit in 53 bits.
 */
export function nativePointer(value: unknown): number | null {
  if (typeof value === "number") return value === 0 ? null : value;
  if (typeof value === "bigint") return value === 0n ? null : Number(value);
  if (value === null || value === undefined) return null;
  throw new Error("Not a native pointer");
}
