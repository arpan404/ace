// SPDX-License-Identifier: Apache-2.0

/**
 * Which backend serves each native boundary (ADR 0223 §8, E0). Each switch is
 * read once here at the process's I/O boundary; shells ask the decision
 * functions below at each new instance and never read the environment
 * themselves. Unset is today's TypeScript; set without the addon, the
 * refusing side fails at startup rather than falling back.
 *
 * `ACE_NATIVE_CROSS=<switch>` selects the backend per boot of a root: a boot
 * is the opening of the event database (the store's connection factory, for
 * `ACE_STORE`, `ACE_TRANSLATORS`, `ACE_SESSIONS`, `ACE_ENGINE`) or of the
 * process journal (`ProcessInventory`'s open, for `ACE_SUPERVISOR`).
 * `ACE_NATIVE_CROSS=ACE_GIT` instead alternates the backend per git call
 * inside one process (see `gitCrossSelected`), starting on `native` or on
 * `typescript` per `ACE_GIT_CROSS_START`, for `scripts/native-cross.ts`. Boot _n_
 * of a root takes the switch's value for even _n_ and the opposite for odd
 * _n_; _n_ comes from the append-only log at `ACE_NATIVE_CROSS_LOG` (one JSON
 * line per boot: root, _n_, switch, the backend boot _n_ asked for, the backend
 * actually in effect for that open, pid), counted under an advisory lock so
 * sibling processes count the same boots. `ACE_STORE`, `ACE_SUPERVISOR` and
 * `ACE_STORE_WRITER` take a value only at a new process's boot, so a second
 * open in the same process runs the first boot's backend: the log's effective
 * value is what the gate asserts, not the requested one. Translators and
 * sessions created after a boot take its backend.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type NativeBackend = "native" | "typescript";
export type CoreBackend = "native" | "wasm" | "typescript";

/** A native transport part, as `ACE_TRANSPORT` names it (ADR 0226, T0.1). */
export type TransportPart = "loopback" | "remote";

/** A phase's needs: it can be on only while every phase it names is on. */
export interface SwitchNeed {
  phase: string;
  needs: readonly string[];
}

/** The eight switches the cross-mode gate can name. */
export type CrossSwitch =
  | "ACE_STORE"
  | "ACE_TRANSLATORS"
  | "ACE_SESSIONS"
  | "ACE_SUPERVISOR"
  | "ACE_CORE"
  | "ACE_ENGINE"
  | "ACE_GIT"
  | "ACE_STORE_WRITER";

const switches: readonly CrossSwitch[] = [
  "ACE_STORE",
  "ACE_TRANSLATORS",
  "ACE_SESSIONS",
  "ACE_SUPERVISOR",
  "ACE_CORE",
  "ACE_ENGINE",
  "ACE_GIT",
  "ACE_STORE_WRITER",
];

/** The providers `ACE_TRANSLATORS` and `ACE_SESSIONS` name, in canonical log order. */
const providers = ["codex", "claude", "cursor", "opencode", "acp", "pi"] as const;
export type NativeProvider = (typeof providers)[number];

function parseList(value: string | undefined, name: string): ReadonlySet<NativeProvider> {
  const asked = new Set<NativeProvider>();
  for (const part of (value ?? "").split(",")) {
    const provider = part.trim();
    if (!provider) continue;
    if (!(providers as readonly string[]).includes(provider))
      throw new Error(`${name} names an unknown provider: ${provider}`);
    asked.add(provider as NativeProvider);
  }
  return asked;
}

function complement(list: ReadonlySet<NativeProvider>): ReadonlySet<NativeProvider> {
  return new Set(providers.filter((provider) => !list.has(provider)));
}

/** The effective provider list as the log records it, in canonical order. */
function listBackend(list: ReadonlySet<NativeProvider>): string {
  return providers.filter((provider) => list.has(provider)).join(",");
}

const translators = parseList(process.env.ACE_TRANSLATORS, "ACE_TRANSLATORS");
const sessions = parseList(process.env.ACE_SESSIONS, "ACE_SESSIONS");
const supervisor = process.env.ACE_SUPERVISOR === "native";
const engine = process.env.ACE_ENGINE === "native";
const core = process.env.ACE_CORE;
if (core !== undefined && core !== "native" && core !== "wasm")
  throw new Error("ACE_CORE takes native or wasm");
const cross = process.env.ACE_NATIVE_CROSS;
if (cross !== undefined && !(switches as readonly string[]).includes(cross))
  throw new Error(`ACE_NATIVE_CROSS names an unknown switch: ${cross}`);
const crossSwitch = cross as CrossSwitch | undefined;
const crossLog = process.env.ACE_NATIVE_CROSS_LOG;
if (crossSwitch !== undefined && !crossLog)
  throw new Error("ACE_NATIVE_CROSS needs ACE_NATIVE_CROSS_LOG");

/**
 * `ACE_SUPERVISOR`, `ACE_SESSIONS` and `ACE_ENGINE` refuse to start without
 * `ACE_STORE=native`: the supervisor's journal and the engine's tables are
 * SQLite, and one SQLite library per file is the rule (ADR 0222).
 */
const store = process.env.ACE_STORE === "native";

/**
 * `ACE_STORE_WRITER`, a comma list of `fold`, `sequences`, `events`, `columns`,
 * `live`, `transactions` (porting guide rule 9). Off by default. It needs
 * `ACE_STORE=native` and refuses to start without it, and each part refuses
 * to start without the parts before it in that list.
 */
export type StoreWriterPart = "fold" | "sequences" | "events" | "columns" | "live" | "transactions";

/** The writer parts in canonical log order. */
const writerPartsOrder: readonly StoreWriterPart[] = [
  "fold",
  "sequences",
  "events",
  "columns",
  "live",
  "transactions",
];

function parseWriterParts(
  value: string | undefined,
  name = "ACE_STORE_WRITER",
): ReadonlySet<StoreWriterPart> {
  const asked = new Set<StoreWriterPart>();
  for (const part of (value ?? "").split(",")) {
    const partName = part.trim();
    if (!partName) continue;
    if (!(writerPartsOrder as readonly string[]).includes(partName))
      throw new Error(`${name} names an unknown part: ${partName}`);
    asked.add(partName as StoreWriterPart);
  }
  return asked;
}

/** Refuses a part without the parts before it in `writerPartsOrder`, naming both. */
function checkWriterPrefixes(parts: ReadonlySet<StoreWriterPart>, name: string): void {
  for (let index = 1; index < writerPartsOrder.length; index++) {
    const part = writerPartsOrder[index] as StoreWriterPart;
    const need = writerPartsOrder[index - 1] as StoreWriterPart;
    if (parts.has(part) && !parts.has(need)) throw new Error(`${name}=${part} needs ${need}`);
  }
}

const writerPartsValue = parseWriterParts(process.env.ACE_STORE_WRITER);
if (writerPartsValue.size > 0 && !store) throw new Error("ACE_STORE_WRITER needs ACE_STORE=native");
checkWriterPrefixes(writerPartsValue, "ACE_STORE_WRITER");
/**
 * The parts a starting-off cross run alternates on with (`scripts/native-cross.ts`), checked
 * like `ACE_STORE_WRITER` itself: it is read when the switch is off, so it names a boot's
 * off-side value rather than a second live switch.
 */
const writerCrossValue = parseWriterParts(
  process.env.ACE_STORE_WRITER_CROSS,
  "ACE_STORE_WRITER_CROSS",
);
if (writerCrossValue.size > 0 && !store)
  throw new Error("ACE_STORE_WRITER_CROSS needs ACE_STORE=native");
checkWriterPrefixes(writerCrossValue, "ACE_STORE_WRITER_CROSS");
const offender =
  crossSwitch === "ACE_SUPERVISOR" || crossSwitch === "ACE_SESSIONS" || crossSwitch === "ACE_ENGINE"
    ? crossSwitch
    : supervisor
      ? "ACE_SUPERVISOR"
      : sessions.size > 0
        ? "ACE_SESSIONS"
        : engine
          ? "ACE_ENGINE"
          : undefined;
if (offender !== undefined && !store) throw new Error(`${offender} needs ACE_STORE=native`);

/**
 * Why `ACE_SESSIONS` cannot run, or `undefined` when it can (E3.0a). A native session diverts
 * the pipes of a child the native supervisor spawned, so it needs the native supervisor as well
 * as the store's SQLite, and `ACE_NATIVE_CROSS=ACE_SUPERVISOR` cannot pair with it: a boot on the
 * TypeScript supervisor could not divert a pipe.
 */
export function sessionSwitchRefusal(input: {
  sessions: readonly string[];
  store: boolean;
  supervisor: boolean;
  cross: CrossSwitch | undefined;
}): string | undefined {
  const named = input.sessions.length > 0 || input.cross === "ACE_SESSIONS";
  if (named && !input.store) return "ACE_SESSIONS needs ACE_STORE=native";
  if (named && !input.supervisor) return "ACE_SESSIONS needs ACE_SUPERVISOR=native";
  if (input.sessions.length > 0 && input.cross === "ACE_SUPERVISOR")
    return "ACE_NATIVE_CROSS=ACE_SUPERVISOR cannot run with ACE_SESSIONS";
  return undefined;
}

const sessionRefusal = sessionSwitchRefusal({
  sessions: [...sessions],
  store,
  supervisor,
  cross: crossSwitch,
});
if (sessionRefusal !== undefined) throw new Error(sessionRefusal);

/**
 * Why `ACE_ENGINE` cannot run, or `undefined` when it can (E5.1). The native engine shares the
 * store's Rust transaction stack, which only the writer's `transactions` part turns on, and a
 * boot without the Rust stack cannot host it.
 */
export function engineSwitchRefusal(input: {
  engine: boolean;
  store: boolean;
  writer: ReadonlySet<StoreWriterPart>;
  cross: CrossSwitch | undefined;
}): string | undefined {
  const named = input.engine || input.cross === "ACE_ENGINE";
  if (named && !input.store) return "ACE_ENGINE needs ACE_STORE=native";
  if (named && !input.writer.has("transactions"))
    return "ACE_ENGINE needs ACE_STORE_WRITER=…,transactions";
  if (named && (input.cross === "ACE_STORE_WRITER" || input.cross === "ACE_STORE"))
    return `ACE_NATIVE_CROSS=${input.cross} cannot run with ACE_ENGINE`;
  return undefined;
}

const engineRefusal = engineSwitchRefusal({
  engine,
  store,
  writer: writerPartsValue,
  cross: crossSwitch,
});
if (engineRefusal !== undefined) throw new Error(engineRefusal);

/**
 * `ACE_GIT=<parts>` (ADR 0224 §1, G0): a comma list of the git parts served
 * natively: `refs`, `core`, `reads`, `writes`, `checkpoints`, `snapshot-hash`,
 * `status-gix`. Unknown words refuse to start, as does a part without its
 * prerequisites: `reads` without `core`, or anything but `refs` without
 * `ACE_SUPERVISOR=native` (such a part spawns through the supervisor).
 */
export type GitPart =
  | "refs"
  | "core"
  | "reads"
  | "writes"
  | "checkpoints"
  | "snapshot-hash"
  | "status-gix";

/** The git parts in canonical log order. */
const gitPartsOrder: readonly GitPart[] = [
  "refs",
  "core",
  "reads",
  "writes",
  "checkpoints",
  "snapshot-hash",
  "status-gix",
];

function parseGitParts(value: string | undefined): ReadonlySet<GitPart> {
  const asked = new Set<GitPart>();
  for (const part of (value ?? "").split(",")) {
    const name = part.trim();
    if (!name) continue;
    if (!(gitPartsOrder as readonly string[]).includes(name))
      throw new Error(`ACE_GIT names an unknown part: ${name}`);
    asked.add(name as GitPart);
  }
  return asked;
}

const gitPartsValue = parseGitParts(process.env.ACE_GIT);
if (gitPartsValue.has("reads") && !gitPartsValue.has("core"))
  throw new Error("ACE_GIT=reads needs core");
const gitNeedsSupervisor = [...gitPartsValue].some((part) => part !== "refs");
if (gitNeedsSupervisor && !supervisor)
  throw new Error("ACE_GIT names a part past refs without ACE_SUPERVISOR=native");

/** The git parts served natively by instances constructed in this process. */
export function gitParts(): ReadonlySet<GitPart> {
  return gitPartsValue;
}

/** Whether new `GitService` instances serve `part` natively. */
export function gitPartOn(part: GitPart): boolean {
  return gitPartsValue.has(part);
}

const gitCrossStart = process.env.ACE_GIT_CROSS_START;
if (gitCrossStart !== undefined && gitCrossStart !== "native" && gitCrossStart !== "typescript")
  throw new Error(`ACE_GIT_CROSS_START takes native or typescript, not ${gitCrossStart}`);

/** Per-call selections so far under `ACE_NATIVE_CROSS=ACE_GIT`. */
let gitCrossCalls = 0;

/**
 * The backend of the next git call under `ACE_NATIVE_CROSS=ACE_GIT`:
 * alternates per call from `ACE_GIT_CROSS_START` (default `native`), so one
 * run proves both orders. `undefined` when the cross gate is off.
 */
export function gitCrossSelected(): NativeBackend | undefined {
  if (crossSwitch !== "ACE_GIT" || gitPartsValue.size === 0) return undefined;
  const selected = (gitCrossCalls++ % 2 === 0) === (gitCrossStart !== "typescript");
  return selected ? "native" : "typescript";
}

/** A boot's backend per switch, from the latest boot hook in this process. */
const bootBackend: Partial<Record<CrossSwitch, string>> = {};
/** Process-wide switches fix their value at the process's first boot. */
const processBoot: Partial<Record<CrossSwitch, string>> = {};

type BootLine = {
  root: string;
  n: number;
  switch: CrossSwitch;
  backend: string;
  effective: string;
  pid: number;
};

function readLog(log: string): BootLine[] {
  let text: string;
  try {
    text = readFileSync(log, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BootLine);
}

/**
 * Runs `run` with the log locked, so sibling processes count the same boots.
 * The lock is a directory (atomic on every platform) holding the holder's pid
 * and time; a holder older than 30 s or with no live pid is stale and taken.
 */
function locked(log: string, run: () => void): void {
  const dir = `${log}.lock`;
  const holder = join(dir, "holder");
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(holder, JSON.stringify({ pid: process.pid, at: Date.now() }));
      try {
        run();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let stale = false;
    try {
      const held = JSON.parse(readFileSync(holder, "utf8")) as { pid: number; at: number };
      try {
        process.kill(held.pid, 0);
      } catch {
        stale = true;
      }
      if (!stale && Date.now() - held.at > 30_000) stale = true;
    } catch {
      stale = true;
    }
    if (stale) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`ACE_NATIVE_CROSS_LOG lock is held: ${dir}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function envBackend(name: CrossSwitch): string {
  switch (name) {
    case "ACE_TRANSLATORS":
      return listBackend(translators);
    case "ACE_SESSIONS":
      return listBackend(sessions);
    case "ACE_SUPERVISOR":
      return supervisor ? "native" : "typescript";
    case "ACE_ENGINE":
      return engine ? "native" : "typescript";
    case "ACE_CORE":
      return core ?? "typescript";
    case "ACE_STORE":
      return store ? "native" : "typescript";
    case "ACE_GIT":
      // Unused: git alternates per call, never per boot. The canonical part list.
      return gitPartsOrder.filter((part) => gitPartsValue.has(part)).join(",");
    case "ACE_STORE_WRITER":
      return writerPartsOrder.filter((part) => writerPartsValue.has(part)).join(",");
  }
}

/** The opposite backend: native reads typescript and back; a list complements. */
function opposite(name: CrossSwitch, backend: string): string {
  switch (name) {
    case "ACE_TRANSLATORS":
    case "ACE_SESSIONS": {
      const list = new Set(backend.length > 0 ? (backend.split(",") as NativeProvider[]) : []);
      return listBackend(complement(list));
    }
    case "ACE_CORE":
      return backend === "native" || backend === "wasm" ? "typescript" : "native";
    case "ACE_GIT":
      // Unused: git alternates per call, never per boot. The complement list.
      return gitPartsOrder.filter((part) => !backend.split(",").includes(part)).join(",");
    case "ACE_STORE_WRITER":
      // The writer's parts are prefix-closed, so a complement would refuse to
      // start. Alternation is on versus off: a set run goes off, and an empty
      // run takes `ACE_STORE_WRITER_CROSS` (the starting-on run's value, from
      // `scripts/native-cross.ts`) or the smallest part on its own, so the
      // starting-off run alternates with the same parts the other run used.
      if (backend.length > 0) return "";
      return process.env.ACE_STORE_WRITER_CROSS ?? "fold";
    default:
      return backend === "native" ? "typescript" : "native";
  }
}

/** The switches that fix their value at a process's first boot and never again (ADR 0222, constraint 2). */
function processFixed(name: CrossSwitch): boolean {
  return name === "ACE_STORE" || name === "ACE_SUPERVISOR" || name === "ACE_STORE_WRITER";
}

/** Records a boot of `root` for the cross switch and remembers its backend. */
function noteBoot(root: string, kinds: readonly CrossSwitch[]): void {
  if (crossSwitch === undefined || crossLog === undefined) return;
  if (!kinds.includes(crossSwitch)) return;
  const name = crossSwitch;
  locked(crossLog, () => {
    const fresh = readLog(crossLog);
    const n = fresh.filter((line) => line.root === root && line.switch === name).length;
    const requested = n % 2 === 0 ? envBackend(name) : opposite(name, envBackend(name));
    let effective: string;
    if (processFixed(name)) {
      // A process-wide switch keeps what it took at this process's first
      // boot; a later open here runs that value whatever this boot asked for.
      effective = processBoot[name] ?? requested;
      processBoot[name] = effective;
    } else {
      bootBackend[name] = requested;
      effective = requested;
    }
    appendFileSync(
      crossLog,
      `${JSON.stringify({ root, n, switch: name, backend: requested, effective, pid: process.pid })}\n`,
    );
  });
}

/**
 * The root a database path belongs to: the directory holding the database.
 * Crash copies (`crash.sqlite` beside `events.sqlite`) and the journal beside
 * the event database boot the same root, which is what the cross-mode gate
 * asserts alternation on. `:memory:` databases have no durable root.
 */
function bootRoot(path: string): string | undefined {
  if (path === ":memory:") return undefined;
  return dirname(resolve(path));
}

/**
 * The store's connection factory calls this once per event-database open.
 * Translators, sessions and engines created after the boot take its backend.
 */
export function noteDatabaseBoot(path: string): void {
  const root = bootRoot(path);
  if (root === undefined) return;
  noteBoot(root, [
    "ACE_STORE",
    "ACE_TRANSLATORS",
    "ACE_SESSIONS",
    "ACE_ENGINE",
    "ACE_STORE_WRITER",
  ]);
}

/** `ProcessInventory`'s constructor calls this once per journal open. */
export function noteJournalBoot(path: string): void {
  const root = bootRoot(path);
  if (root === undefined) return;
  noteBoot(root, ["ACE_SUPERVISOR"]);
}

function currentList(
  name: CrossSwitch,
  env: ReadonlySet<NativeProvider>,
): ReadonlySet<NativeProvider> {
  const backend = bootBackend[name];
  if (crossSwitch !== name || backend === undefined) return env;
  return new Set(backend.length > 0 ? (backend.split(",") as NativeProvider[]) : []);
}

function currentScalar(name: CrossSwitch, env: NativeBackend): NativeBackend {
  const backend = processBoot[name] ?? bootBackend[name];
  if (crossSwitch !== name || backend === undefined) return env;
  return backend === "native" ? "native" : "typescript";
}

/** The backend of a new translator for `provider`: the current boot's, else the switch's. */
export function translatorBackend(provider: string): NativeBackend {
  if (!(providers as readonly string[]).includes(provider))
    throw new Error(`Unknown provider: ${provider}`);
  return currentList("ACE_TRANSLATORS", translators).has(provider as NativeProvider)
    ? "native"
    : "typescript";
}

/** The backend of a new session for `provider`: the current boot's, else the switch's. */
export function sessionBackend(provider: string): NativeBackend {
  if (!(providers as readonly string[]).includes(provider))
    throw new Error(`Unknown provider: ${provider}`);
  return currentList("ACE_SESSIONS", sessions).has(provider as NativeProvider)
    ? "native"
    : "typescript";
}

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";

/**
 * The addon every session shell loads: `ACE_SESSIONS_ADDON`, else `ACE_STORE_ADDON`, else the
 * development build in `native/daemon`. A shell that finds no file there throws
 * `ACE_SESSIONS=<provider> needs the sessions addon at <path>`; it never falls back to the
 * TypeScript session.
 */
export function sessionsAddonPath(): string {
  // Precedence is by presence, not by truthiness: a set-but-empty value names no addon and is
  // refused, rather than silently taking the store's or the development build.
  const own = process.env.ACE_SESSIONS_ADDON;
  const [name, explicit] =
    own !== undefined
      ? (["ACE_SESSIONS_ADDON", own] as const)
      : (["ACE_STORE_ADDON", process.env.ACE_STORE_ADDON] as const);
  if (explicit === undefined)
    return fileURLToPath(
      new URL(`../../../native/daemon/target/release/${library}`, import.meta.url),
    );
  if (explicit === "") throw new Error(`${name} is set but empty`);
  return explicit;
}

/** The backend of a new engine: the current boot's, else the switch's. */
export function engineBackend(): NativeBackend {
  return currentScalar("ACE_ENGINE", engine ? "native" : "typescript");
}

/** The backend of the supervisor: fixed at this process's first journal boot, else the switch's. */
export function supervisorBackend(): NativeBackend {
  return currentScalar("ACE_SUPERVISOR", supervisor ? "native" : "typescript");
}

/** The core's loader: `native`, `wasm`, or today's TypeScript. The core never boots. */
export function coreBackend(): CoreBackend {
  if (core === "native" || core === "wasm") return core;
  return "typescript";
}

/** The store's backend: fixed at this process's first database boot, else the switch's. */
export function storeBackend(): NativeBackend {
  return currentScalar("ACE_STORE", store ? "native" : "typescript");
}

function currentWriterParts(): ReadonlySet<StoreWriterPart> {
  const backend = processBoot["ACE_STORE_WRITER"] ?? bootBackend["ACE_STORE_WRITER"];
  if (crossSwitch !== "ACE_STORE_WRITER" || backend === undefined) return writerPartsValue;
  return parseWriterParts(backend);
}

/** The writer parts served natively, resolved once per process at the first database boot. */
export function storeWriterParts(): ReadonlySet<StoreWriterPart> {
  return currentWriterParts();
}

/** Whether new `EventWriter` folds serve `part` natively. */
export function storeWriterOn(part: StoreWriterPart): boolean {
  return currentWriterParts().has(part);
}

/**
 * A writer part list as the log and a report write it: `parseWriterParts`'s rules, then
 * canonical order, without repeats. `undefined` and `""` are the empty list.
 */
export function canonicalWriterParts(value: string | undefined): string {
  const asked = parseWriterParts(value);
  return writerPartsOrder.filter((part) => asked.has(part)).join(",");
}

/**
 * Whether Android video's scrcpy socket is read by ace-media itself (D1, `ACE_SCRCPY_VIDEO=media`)
 * or by the daemon's JavaScript (unset, today's path). Read once per capture; with the switch on
 * and no ace-media build with the scrcpy reader, the capture fails rather than falling back.
 */
export function scrcpyVideoBackend(): NativeBackend {
  const value = process.env.ACE_SCRCPY_VIDEO;
  if (value === undefined) return "typescript";
  if (value === "media") return "native";
  throw new Error("ACE_SCRCPY_VIDEO takes media");
}

export function crossLogPath(): string | undefined {
  return crossLog;
}
export function crossSwitchName(): CrossSwitch | undefined {
  return crossSwitch;
}

/**
 * A phase named explicitly needs one that is not on: the boot is refused, before anything binds
 * or opens, naming both (ADR 0226 §6).
 */
export class NativeSwitchConflict extends Error {
  constructor(phase: string, need: string) {
    super(`${phase} needs ${need}, which is not on`);
    this.name = "NativeSwitchConflict";
  }
}

/**
 * Resolves dependent switches together, before anything binds or opens (ADR 0226 §6). The set
 * starts as `explicit ∪ defaultOn`. A phase that is on only by default, whose need is off, leaves
 * together with every phase that needs it, repeated until nothing changes, so the table's order
 * never decides the outcome; each fall-back names the need it lost. A phase named explicitly is
 * never dropped: if a need is still off, the boot is refused instead of silently starting.
 */
export function resolveSwitches(
  explicit: ReadonlySet<string>,
  defaultOn: ReadonlySet<string>,
  needs: readonly SwitchNeed[],
): { on: ReadonlySet<string>; fellBack: readonly { phase: string; because: string }[] } {
  const on = new Set([...explicit, ...defaultOn]);
  const fellBack: { phase: string; because: string }[] = [];
  const defaultOnly = (phase: string) => defaultOn.has(phase) && !explicit.has(phase);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of needs) {
      if (!on.has(row.phase) || !defaultOnly(row.phase)) continue;
      const missing = row.needs.find((need) => !on.has(need));
      if (missing === undefined) continue;
      on.delete(row.phase);
      fellBack.push({ phase: row.phase, because: missing });
      changed = true;
    }
  }
  for (const row of needs) {
    if (!explicit.has(row.phase)) continue;
    const missing = row.needs.find((need) => !on.has(need));
    if (missing !== undefined) throw new NativeSwitchConflict(row.phase, missing);
  }
  return { on, fellBack };
}

/**
 * `ACE_TRANSPORT` names the transport parts served natively: `native` is the loopback listener,
 * `native,remote` adds the remote listeners. Unset is today's TypeScript; a set value that is
 * neither refuses to start, quoting what it read (so an empty value shows as `""`).
 */
export function explicitTransportPhases(value: string | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set<string>();
  if (value === "native") return new Set(["transport.loopback"]);
  if (value === "native,remote") return new Set(["transport.loopback", "transport.remote"]);
  throw new Error(`ACE_TRANSPORT=${JSON.stringify(value)} is not native or native,remote`);
}

/** Each phase's needs. The remote listeners route through the loopback listener's table. */
const transportNeeds: readonly SwitchNeed[] = [
  { phase: "transport.remote", needs: ["transport.loopback"] },
];

/** Nothing is default-on: every native part ships behind its switch. */
const transportResolved = resolveSwitches(
  explicitTransportPhases(process.env.ACE_TRANSPORT),
  new Set<string>(),
  transportNeeds,
);

/** The transport parts served natively, resolved once at load; nothing reads it yet. */
export function transportParts(): ReadonlySet<TransportPart> {
  const parts = new Set<TransportPart>();
  if (transportResolved.on.has("transport.loopback")) parts.add("loopback");
  if (transportResolved.on.has("transport.remote")) parts.add("remote");
  return parts;
}
