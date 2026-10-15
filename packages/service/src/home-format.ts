import { z } from "zod";

/**
 * The format of everything ace keeps in its data home: every SQLite database and its schema, the
 * enum values stored in rows, and the JSON state files (ADR 0081).
 *
 * Bump it by one in the same change that alters any persisted format this build's predecessor
 * cannot read. A daemon that finds a home in an older format backs it up (renamed beside it as
 * `<home>-v<old>`) and starts in a fresh home; one that finds a newer format refuses to start
 * (exit 65) and leaves the home alone. ace is pre-release, so nothing is migrated. Never
 * decrease it.
 */
export const HOME_FORMAT_VERSION = 1;

/** `<home>/ace-format.json`: `{"format":"ace-vN","createdAt":"<ISO time>"}`. */
export const HOME_FORMAT_FILE = "ace-format.json";

/** Format names as the marker stores them: version 1 is `ace-v1`. */
export function formatName(version: number): string {
  return `ace-v${version}`;
}

const Marker = z.looseObject({
  format: z
    .string()
    .regex(/^ace-v(?:0|[1-9]\d{0,8})$/)
    .transform((name) => Number(name.slice("ace-v".length))),
  createdAt: z.string().max(64),
});

/** The marker file's text for a home created at `createdAt` in `version`. */
export function renderMarker(version: number, createdAt: Date): string {
  return `${JSON.stringify({ format: formatName(version), createdAt: createdAt.toISOString() })}\n`;
}

/** The version a marker records, or undefined when the text is not a marker ace can read. */
export function markerVersion(text: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const marker = Marker.safeParse(parsed);
  return marker.success ? marker.data.format : undefined;
}

/** What is at the home path, with no paths or filesystem calls. */
export type HomeFacts =
  | { kind: "missing" }
  | { kind: "empty" }
  /** Data without a readable marker: an earlier ace, or anything else. Version 0. */
  | { kind: "unversioned" }
  | { kind: "versioned"; version: number };

export type HomePlan =
  /** Nothing there: make the directory and write the marker. */
  | { action: "create" }
  /** An empty directory (a fresh ACE_HOME): write the marker into it. */
  | { action: "adopt" }
  | { action: "reuse" }
  /** Rename the home aside as `<home>-v<from>` and create a fresh one. */
  | { action: "back-up"; from: number }
  | { action: "refuse-newer"; stored: number };

export function planHome(facts: HomeFacts, current: number): HomePlan {
  if (facts.kind === "missing") return { action: "create" };
  if (facts.kind === "empty") return { action: "adopt" };
  const stored = facts.kind === "versioned" ? facts.version : 0;
  if (stored === current) return { action: "reuse" };
  if (stored > current) return { action: "refuse-newer", stored };
  return { action: "back-up", from: stored };
}

/**
 * The first free backup name for `home` (a base name, such as `.ace`) in format `from`:
 * `.ace-v0`, then `.ace-v0.1`, `.ace-v0.2` and so on. An existing backup is never reused.
 */
export function backupName(home: string, from: number, taken: (name: string) => boolean): string {
  const base = `${home}-v${from}`;
  if (!taken(base)) return base;
  for (let index = 1; index <= 10_000; index++) {
    const name = `${base}.${index}`;
    if (!taken(name)) return name;
  }
  throw new Error(`Too many ace data backups named ${base}; remove the ones you no longer need`);
}

/** Raised before anything is opened when the home holds data from a newer ace build. */
export class NewerDataError extends Error {
  readonly home: string;
  readonly stored: string;
  readonly supported: string;
  constructor(home: string, stored: number, supported: number) {
    super(
      `This ace build is older than the data in ${home}: data format ${formatName(stored)}, build supports ${formatName(supported)}. Open the newest ace or update this one.`,
    );
    this.name = "NewerDataError";
    this.home = home;
    this.stored = formatName(stored);
    this.supported = formatName(supported);
  }
}

/** Raised instead of backing up a home whose daemon is still running. */
export class LiveHomeError extends Error {
  readonly home: string;
  constructor(home: string, pid: number | undefined) {
    super(
      `The ace data in ${home} needs a fresh start, but an older ace daemon${pid === undefined ? "" : ` (pid ${pid})`} is still using it. Quit that ace (or run its \`ace stop\`), then open ace again. Nothing was moved.`,
    );
    this.name = "LiveHomeError";
    this.home = home;
  }
}

/** Raised instead of backing up a home an older ace (0.x, with no daemon lock) still has open. */
export class OldAceRunningError extends LiveHomeError {
  constructor(home: string, pid: number) {
    super(home, pid);
    this.message = `An older ace (pid ${pid}) is still running and using ${home}. Quit the old ace first, then open ace again. Nothing was moved.`;
    this.name = "OldAceRunningError";
  }
}
