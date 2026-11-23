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
 * line per boot: root, _n_, switch, backend, pid), counted under an advisory
 * lock so sibling processes count the same boots. `ACE_STORE` and
 * `ACE_SUPERVISOR` take a value only at a new process's boot. Translators and
 * sessions created after a boot take its backend.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type NativeBackend = "native" | "typescript";
export type CoreBackend = "native" | "wasm" | "typescript";

/** The seven switches the cross-mode gate can name. */
export type CrossSwitch =
  | "ACE_STORE"
  | "ACE_TRANSLATORS"
  | "ACE_SESSIONS"
  | "ACE_SUPERVISOR"
  | "ACE_CORE"
  | "ACE_ENGINE"
  | "ACE_GIT";

const switches: readonly CrossSwitch[] = [
  "ACE_STORE",
  "ACE_TRANSLATORS",
  "ACE_SESSIONS",
  "ACE_SUPERVISOR",
  "ACE_CORE",
  "ACE_ENGINE",
  "ACE_GIT",
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

type BootLine = { root: string; n: number; switch: CrossSwitch; backend: string; pid: number };

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
    default:
      return backend === "native" ? "typescript" : "native";
  }
}

/** Records a boot of `root` for the cross switch and remembers its backend. */
function noteBoot(root: string, kinds: readonly CrossSwitch[]): void {
  if (crossSwitch === undefined || crossLog === undefined) return;
  if (!kinds.includes(crossSwitch)) return;
  const name = crossSwitch;
  locked(crossLog, () => {
    const fresh = readLog(crossLog);
    const n = fresh.filter((line) => line.root === root && line.switch === name).length;
    const backend = n % 2 === 0 ? envBackend(name) : opposite(name, envBackend(name));
    appendFileSync(
      crossLog,
      `${JSON.stringify({ root, n, switch: name, backend, pid: process.pid })}\n`,
    );
    if (name === "ACE_STORE" || name === "ACE_SUPERVISOR") processBoot[name] ??= backend;
    else bootBackend[name] = backend;
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
  noteBoot(root, ["ACE_STORE", "ACE_TRANSLATORS", "ACE_SESSIONS", "ACE_ENGINE"]);
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

export function crossLogPath(): string | undefined {
  return crossLog;
}
export function crossSwitchName(): CrossSwitch | undefined {
  return crossSwitch;
}
