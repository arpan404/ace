import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertTestHomeIsolation } from "./test-home-guard.ts";
import { claimHome, type HomeClaim } from "./home-claim.ts";
import { carryRelease } from "./home-release.ts";
import {
  HOME_FORMAT_FILE,
  HOME_FORMAT_VERSION,
  NewerDataError,
  backupName,
  formatName,
  markerVersion,
  planHome,
  renderMarker,
  type HomeFacts,
} from "./home-format.ts";

export type PreparedHome =
  | { state: "created" | "reused"; root: string }
  /** The old home was renamed to `backup` and `root` is a fresh, empty home. */
  | {
      state: "fresh";
      root: string;
      backup: string;
      previousFormat: string;
      /** The installed release moved back into the fresh home, if the backup held one. */
      release?: string;
    };

export interface FreshStartPorts {
  now(): Date;
  /** Holds the old home's daemon lock across the rename, or throws `LiveHomeError`. */
  claim(root: string): HomeClaim;
  /** The format this build writes; tests pass a later one to rehearse a bump. */
  version?: number;
}

const systemPorts: FreshStartPorts = { now: () => new Date(), claim: (root) => claimHome(root) };

function code(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

function readFacts(root: string): HomeFacts {
  let names: string[];
  try {
    if (!statSync(root).isDirectory())
      throw new Error(`Refusing ace data home ${root}: it is not a directory`);
    names = readdirSync(root);
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
    // A link to nothing is still something at the path: set it aside, never write through it.
    return exists(root) ? { kind: "unversioned" } : { kind: "missing" };
  }
  if (names.length === 0) return { kind: "empty" };
  if (!names.includes(HOME_FORMAT_FILE)) return { kind: "unversioned" };
  let text: string;
  try {
    text = readFileSync(join(root, HOME_FORMAT_FILE), "utf8").slice(0, 4096);
  } catch (error) {
    if (code(error) === "EISDIR") return { kind: "unversioned" };
    throw error;
  }
  const version = markerVersion(text);
  return version === undefined ? { kind: "unversioned" } : { kind: "versioned", version };
}

/** Publishes the marker whole or not at all; a home that already has one keeps it. */
function writeMarker(root: string, version: number, now: Date): boolean {
  const marker = join(root, HOME_FORMAT_FILE);
  const pending = `${marker}.${process.pid}.tmp`;
  writeFileSync(pending, renderMarker(version, now), { mode: 0o600, flag: "w" });
  try {
    linkSync(pending, marker);
    return true;
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(pending);
  }
}

/** Makes the home directory (private) and its marker. False when another start raced us to it. */
function create(root: string, version: number, now: Date): boolean {
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw error;
  }
  return writeMarker(root, version, now);
}

function renameAside(root: string, from: number): string {
  const parent = dirname(root);
  const backup = join(
    parent,
    backupName(basename(root), from, (name) => exists(join(parent, name))),
  );
  try {
    // The backup sits beside the home, in the same directory, so this is one rename(2) on one
    // filesystem. A home that is a link is renamed as the link; what it points at stays put.
    renameSync(root, backup);
  } catch (error) {
    if (code(error) === "EXDEV")
      throw new Error(
        `Cannot set aside the ace data in ${root}: ${backup} is on another filesystem. Move ${root} yourself, then open ace again.`,
        { cause: error },
      );
    throw error;
  }
  return backup;
}

/**
 * Makes `root` a home in this build's format before anything else touches it (ADR 0081). A
 * missing home is created; one in the current format is used as it is; one without a marker or
 * in an older format is renamed aside, in a single rename, and replaced by a fresh home. A home
 * in a newer format throws `NewerDataError`, and one still in use by its daemon throws
 * `LiveHomeError`; neither is moved. Nothing is migrated, copied or deleted.
 */
export function prepareDaemonHome(
  requested: string,
  ports: FreshStartPorts = systemPorts,
): PreparedHome {
  const root = resolve(requested);
  assertTestHomeIsolation(root);
  const version = ports.version ?? HOME_FORMAT_VERSION;
  // Another start can win any step; each retry sees what it left.
  for (let attempt = 0; attempt < 4; attempt++) {
    const plan = planHome(readFacts(root), version);
    if (plan.action === "reuse") return { state: "reused", root };
    if (plan.action === "refuse-newer") throw new NewerDataError(root, plan.stored, version);
    if (plan.action === "create") {
      if (create(root, version, ports.now())) return { state: "created", root };
      continue;
    }
    if (plan.action === "adopt") {
      if (writeMarker(root, version, ports.now())) return { state: "created", root };
      continue;
    }
    const claim = ports.claim(root);
    let backup: string;
    try {
      backup = renameAside(root, plan.from);
    } catch (error) {
      if (code(error) === "ENOENT") continue;
      throw error;
    } finally {
      claim.release();
    }
    create(root, version, ports.now());
    // An install.sh release is the program, not data: it keeps running from the fresh home.
    const release = carryRelease(backup, root);
    return {
      state: "fresh",
      root,
      backup,
      previousFormat: formatName(plan.from),
      ...(release === undefined ? {} : { release }),
    };
  }
  throw new Error(`The ace data home ${root} kept changing while ace started; open ace again`);
}
