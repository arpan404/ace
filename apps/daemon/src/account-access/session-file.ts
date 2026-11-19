import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AceAccount, AceAccountGrant, StoredAceAccountOrigin } from "@ace/protocol/ace-account";

/**
 * The daemon's one ace sign-in (ADR 0111): its machine credential (ADR 0190), bound to this
 * machine's host id, whose grants never speak for the person. A file from before machine
 * credentials holds an ace session instead (no `kind`); the daemon exchanges it for a credential
 * and rewrites the file. Only the daemon reads it; it is never logged.
 */
export const StoredSession = z.object({
  /** A session stored on a former address of ace's backend reads as the current one. */
  origin: StoredAceAccountOrigin,
  token: AceAccountGrant.shape.token,
  account: AceAccount,
  expiresAt: z.number().int().positive(),
  /** `login`: `ace login` created it, so signing out ends it at the backend too. */
  source: z.enum(["handover", "login"]),
  /** `machine`: `token` is this machine's credential. Absent: an ace session, still to exchange. */
  kind: z.literal("machine").optional(),
});
export type StoredSession = z.infer<typeof StoredSession>;

const file = (dataDir: string) => join(dataDir, "ace-account.json");

export async function readSession(dataDir: string): Promise<StoredSession | undefined> {
  let text: string;
  try {
    text = await readFile(file(dataDir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return StoredSession.parse(JSON.parse(text));
  } catch {
    // A damaged file is a signed-out machine, not a daemon that cannot start.
    return undefined;
  }
}

/** Replace the session file atomically, readable by this user only; null removes it. */
export async function writeSession(dataDir: string, session: StoredSession | null): Promise<void> {
  if (!session) {
    await rm(file(dataDir), { force: true });
    return;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${file(dataDir)}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(StoredSession.parse(session)), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file(dataDir));
}

/**
 * A machine credential this daemon chose and is asking the backend to issue (ADR 0190), written
 * before it asks: if the answer is lost or the daemon stops, the next start tries the credential
 * itself, or asks again with it. It holds no session.
 */
export const PendingCredential = z.object({
  origin: StoredAceAccountOrigin,
  credential: AceAccountGrant.shape.token,
  source: StoredSession.shape.source,
  /**
   * The sign-in this credential is to replace: the stored token when it was asked for, or null
   * for none. Recovered only while that is still the machine's sign-in; otherwise it is stale.
   */
  predecessor: AceAccountGrant.shape.token.nullable(),
});
export type PendingCredential = z.infer<typeof PendingCredential>;

const pendingFile = (dataDir: string) => join(dataDir, "ace-account.pending.json");

export async function readPending(dataDir: string): Promise<PendingCredential | undefined> {
  try {
    return PendingCredential.parse(JSON.parse(await readFile(pendingFile(dataDir), "utf8")));
  } catch {
    return undefined;
  }
}

export async function writePending(
  dataDir: string,
  pending: PendingCredential | null,
): Promise<void> {
  if (!pending) {
    await rm(pendingFile(dataDir), { force: true });
    return;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${pendingFile(dataDir)}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(PendingCredential.parse(pending)), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, pendingFile(dataDir));
}
