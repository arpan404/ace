import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AceAccount, AceAccountGrant, StoredAceAccountOrigin } from "@ace/protocol/ace-account";

/** The daemon's one ace session (ADR 0111). Only the daemon reads it; it is never logged. */
export const StoredSession = z.object({
  /** A session stored on a former address of ace's backend reads as the current one. */
  origin: StoredAceAccountOrigin,
  token: AceAccountGrant.shape.token,
  account: AceAccount,
  expiresAt: z.number().int().positive(),
  /** `login`: `ace login` created it, so signing out ends it at the backend too. */
  source: z.enum(["handover", "login"]),
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
