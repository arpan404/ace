import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { shell } from "electron";
import type { OpenInEditor } from "../../shared/contract.ts";
import { defaultOpenAction } from "./open-policy.ts";

/** Editor URL handlers, so no editor CLI needs to be on PATH. */
function editorUrl(request: OpenInEditor): string | undefined {
  const position = `${request.line ? `:${request.line}${request.column ? `:${request.column}` : ""}` : ""}`;
  const path = encodeURI(request.path);
  switch (request.editor) {
    case "vscode":
      return `vscode://file${path}${position}`;
    case "cursor":
      return `cursor://file${path}${position}`;
    case "zed":
      return `zed://file${path}${position}`;
    case "idea":
      return `idea://open?file=${encodeURIComponent(request.path)}${request.line ? `&line=${request.line}` : ""}`;
    default:
      return undefined;
  }
}

export async function openInEditor(request: OpenInEditor): Promise<boolean> {
  if (!existsSync(request.path)) return false;
  const url = editorUrl(request);
  if (url) {
    await shell.openExternal(url);
    return true;
  }
  if (request.editor === "xcode" && process.platform === "darwin") {
    const args = [...(request.line ? ["--line", String(request.line)] : []), request.path];
    return new Promise((resolve) => execFile("xed", args, (error) => resolve(!error)));
  }
  // Judge (and open) what the path resolves to, so a symlink cannot disguise an app.
  const target = realpathSync(request.path);
  if (defaultOpenAction(target, statSync(target).isDirectory(), process.platform) === "reveal") {
    shell.showItemInFolder(target);
    return true;
  }
  return (await shell.openPath(target)) === "";
}

export function reveal(path: string): boolean {
  if (!existsSync(path)) return false;
  shell.showItemInFolder(path);
  return true;
}
