import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { editorCommandArgs } from "@ace/ui-core/editor-commands";
import type { OpenInEditor } from "../../shared/contract.ts";

/**
 * Linux: run the editor launcher the daemon found, since editors' URL schemes (`cursor://`,
 * `idea://`) often have no registered handler there. Only a known editor launcher that is an
 * executable file on this computer runs, detached, with the file and position as arguments.
 * Resolves false when there is nothing to run, so the caller falls back to the URL scheme.
 */
export async function launchEditorCommand(
  request: OpenInEditor,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const command = request.command;
  if (platform !== "linux" || !command || !isAbsolute(command)) return false;
  const args = editorCommandArgs(command, request);
  if (!args) return false;
  try {
    if (!(await stat(command)).isFile()) return false;
    await access(command, constants.X_OK);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    // An IDE launcher may stay in the foreground for the editor's lifetime: never wait on it.
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
