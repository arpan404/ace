import type { CarriedSession, ProviderKind } from "@ace/protocol";

/**
 * One provider's own session, carried to another machine with a working thread (ADR 0191).
 * `capture` names the session's files in the home of the thread's account; `place` writes copies
 * of them, folder paths rewritten, into the target account's home under fresh session ids, so a
 * copy never meets the original or an earlier copy of it (a shared home, a return trip). Session
 * files are provider data, never credentials (ADR 0002): no auth file is ever read or written.
 */
export interface SessionCarrier {
  provider: ProviderKind;
  capture(input: { home: string; nativeSessionId: string }): Promise<CapturedSession>;
  /**
   * `staged` holds the carried files at their paths relative to the source home. Each session
   * id in them is renamed to one `newId` makes, in file names and records alike. Writes only
   * inside `home`, never over an existing file; on failure removes what it wrote.
   */
  place(input: {
    home: string;
    staged: string;
    session: CarriedSession;
    targetCwd: string;
    newId(): string;
  }): Promise<PlacedSession>;
}

export interface CapturedSession {
  nativeSessionId: string;
  /** Each file's path in the source home, and the same path relative to it. */
  files: { source: string; relative: string }[];
}

/** How the session continues there: resumed by id, or forked from its end (ADR 0018). */
export interface PlacedSession {
  /** The copy's fresh id, which the thread there continues. */
  nativeSessionId: string;
  action: "resume" | "fork";
}

/** A session that can't be carried, in words a person reads; the handoff summary goes instead. */
export class SessionNotCarried extends Error {}

/** The most a carried session may hold, in files and bytes. */
export const maxSessionFiles = 512;
export const maxSessionBytes = 256 * 1024 * 1024;

/** File names that hold logins in providers' homes; never read, never written. */
const authNames = new Set([
  "auth.json",
  ".credentials.json",
  "credentials.json",
  ".claude.json",
  "config.toml",
  "settings.json",
]);

/** Refuses a listed file that could hold a credential, whatever lineage named it. */
export function assertSessionFile(relative: string): void {
  const name = relative.split(/[\\/]/).pop() ?? "";
  if (authNames.has(name) || !/\.jsonl?$/.test(name) || relative.split(/[\\/]/).includes(".."))
    throw new SessionNotCarried("A file that isn't part of a session was named");
}
