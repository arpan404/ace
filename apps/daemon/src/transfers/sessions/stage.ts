import { stageFile } from "@ace/accounts/session-files";
import type { CapturedSession } from "./carrier.ts";
import { SessionNotCarried } from "./carrier.ts";

/**
 * Copies a captured session's files into `folder` at their paths relative to the source home,
 * without following links, each checked unchanged while it was read (ADR 0190). The session's
 * writer has stopped by now (the turn was interrupted), so a file still changing is not carried.
 */
export async function stageSession(captured: CapturedSession, folder: string): Promise<string[]> {
  try {
    for (const file of captured.files) await stageFile(file, folder);
  } catch {
    throw new SessionNotCarried("The session changed while it was copied");
  }
  return captured.files.map((file) => file.relative);
}
