import type { DiskFile, FilePort } from "@/features/editor-workbench/index.ts";
import { describeFile } from "@/components/attachment-kind.ts";
import { SpadeRequestError, type SpadeTarget } from "../../spade-requests.ts";
import { readFile } from "../../spade-workspace-api.ts";
import { changedSinceOpened, saveFile } from "../computer-api.ts";

/*
 * The editor's files (W2's FilePort) over a bot's workspace in Spade (ADR 0143): a read is the
 * file manager's read, a version is Spade's revision, and a write names the revision it began
 * from, so a save over a file the bot changed since is a clash, never a lost change.
 */

/** One bot's workspace, as a buffer root names it. */
export interface SpadeFilesAccess {
  target: SpadeTarget;
  bot: string;
  /** Whether a change may go now; says why not, as an Error, when it can't. */
  mayWrite(): true | Error;
}

/** What the editor reads in place of text: a picture or a player is drawn by the viewer. */
function viewerKind(path: string): string | undefined {
  const preview = describeFile({ name: path }).preview;
  if (preview === "image") return "image";
  if (preview === "pdf" || preview === "audio" || preview === "video") return "media";
  return undefined;
}

export function spadeFilePort(access: (root: string) => SpadeFilesAccess): FilePort {
  /** Saves whose revision could not be read back: a version no disk read will ever match. */
  let unconfirmed = 0;
  const read = async (root: string, path: string, signal?: AbortSignal): Promise<DiskFile> => {
    const { target, bot } = access(root);
    const shown = viewerKind(path);
    if (shown) return { kind: "unreadable", reason: shown };
    try {
      const file = await readFile(target, bot, path, signal ? { signal } : {});
      if (file.text === undefined)
        return { kind: "unreadable", reason: file.unreadable === "too_large" ? "large" : "binary" };
      return { kind: "text", text: file.text, version: file.revision ?? "" };
    } catch (error) {
      if (error instanceof SpadeRequestError && error.status === 404) return { kind: "missing" };
      throw error;
    }
  };
  return {
    read: (key, signal) => read(key.root, key.path, signal),
    async write(key, text, expected) {
      const { target, bot, mayWrite } = access(key.root);
      const may = mayWrite();
      if (may !== true) throw may;
      try {
        await saveFile(target, bot, key.path, text, expected ? expected : undefined);
      } catch (error) {
        if (changedSinceOpened(error)) return { kind: "clash" };
        throw error;
      }
      // Spade answers a save with nothing: its revision is read back. When the bot wrote again
      // in between, the version stays unknown, so the next look at the file finds it moved.
      const now = await read(key.root, key.path).catch(() => undefined);
      if (now?.kind === "text" && now.text === text && now.version)
        return { kind: "saved", version: now.version };
      unconfirmed += 1;
      return { kind: "saved", version: `unconfirmed-${unconfirmed}` };
    },
  };
}
