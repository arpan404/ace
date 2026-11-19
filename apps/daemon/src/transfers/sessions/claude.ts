import { lstat } from "node:fs/promises";
import { claudePlan, MigrationFailure } from "@ace/accounts/session-files";
import {
  SessionNotCarried,
  assertSessionFile,
  maxSessionBytes,
  maxSessionFiles,
  type SessionCarrier,
} from "./carrier.ts";
import { placeFiles } from "./place.ts";
import { claudeCwd, claudeProjectFolder, rewriteSession } from "./rewrite.ts";

/**
 * Claude Code keeps a session as `projects/<folder>/<id>.jsonl`, with its subagents' transcripts
 * in `projects/<folder>/<id>/subagents/`, where `<folder>` is named after the checkout. A resume
 * looks the id up under the current checkout's folder, so the copy moves to the target's.
 */
export const claudeCarrier: SessionCarrier = {
  provider: "claude",
  async capture({ home, nativeSessionId }) {
    let plan: Awaited<ReturnType<typeof claudePlan>>;
    try {
      plan = await claudePlan(home, nativeSessionId);
    } catch (error) {
      throw new SessionNotCarried(
        error instanceof MigrationFailure ? error.message : "Claude's session couldn't be read",
      );
    }
    return { nativeSessionId, files: await bounded(plan.files) };
  },
  async place({ home, staged, session, targetCwd }) {
    const folder = claudeProjectFolder(targetCwd);
    if (!folder) throw new SessionNotCarried("The project's folder name is too long for Claude");
    await placeFiles({
      home,
      staged,
      files: session.files.map((from) => ({ from, to: inFolder(from, folder) })),
      rewrite: (text) => rewriteSession(text, session.sourceCwd, targetCwd, claudeCwd),
    });
    return { nativeSessionId: session.nativeSessionId, action: "resume" };
  },
};

/** `projects/<any>/rest` → `projects/<folder>/rest`. */
function inFolder(relative: string, folder: string): string {
  const parts = relative.split(/[\\/]/);
  if (parts[0] !== "projects" || parts.length < 3)
    throw new SessionNotCarried("A Claude session file is outside its projects folder");
  return ["projects", folder, ...parts.slice(2)].join("/");
}

/** The plan's files within the size limits, each one a session file. */
export async function bounded(
  files: { source: string; relative: string }[],
): Promise<{ source: string; relative: string }[]> {
  if (files.length > maxSessionFiles) throw new SessionNotCarried("The session has too many files");
  let bytes = 0;
  for (const file of files) {
    assertSessionFile(file.relative);
    bytes += (await lstat(file.source)).size;
    if (bytes > maxSessionBytes) throw new SessionNotCarried("The session is too large to carry");
  }
  return files.map((file) => ({
    source: file.source,
    relative: file.relative.split("\\").join("/"),
  }));
}
