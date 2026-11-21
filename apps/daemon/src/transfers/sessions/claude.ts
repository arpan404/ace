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
import { claudeCwd, claudeProjectFolder, renameSession, rewriteSession } from "./rewrite.ts";

/**
 * Claude Code keeps a session as `projects/<folder>/<id>.jsonl`, with its subagents' transcripts
 * in `projects/<folder>/<id>/subagents/`, where `<folder>` is named after the checkout. A resume
 * looks the id up under the current checkout's folder, so the copy moves to the target's. The
 * copy takes a fresh id: its file, its subagents' folder and every record's `sessionId`.
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
  async place({ home, staged, session, targetCwd, newId }) {
    const folder = claudeProjectFolder(targetCwd);
    if (!folder) throw new SessionNotCarried("The project's folder name is too long for Claude");
    const from = session.nativeSessionId;
    const to = newId();
    const ids = new Map([[from.toLowerCase(), to]]);
    await placeFiles({
      home,
      staged,
      files: session.files.map((file) => ({ from: file, to: inFolder(file, folder, from, to) })),
      rewrite: (text) =>
        renameSession(rewriteSession(text, session.sourceCwd, targetCwd, claudeCwd), ids),
    });
    return { nativeSessionId: to, action: "resume" };
  },
};

/**
 * `projects/<any>/<id>.jsonl` → `projects/<folder>/<fresh>.jsonl`, and the same for the files
 * in `projects/<any>/<id>/`.
 */
function inFolder(relative: string, folder: string, id: string, fresh: string): string {
  const parts = relative.split(/[\\/]/);
  if (parts[0] !== "projects" || parts.length < 3)
    throw new SessionNotCarried("A Claude session file is outside its projects folder");
  const [name = "", ...rest] = parts.slice(2);
  const renamed = name === id ? fresh : name === `${id}.jsonl` ? `${fresh}.jsonl` : undefined;
  if (renamed === undefined)
    throw new SessionNotCarried("A Claude session file isn't named after its session");
  return ["projects", folder, renamed, ...rest].join("/");
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
