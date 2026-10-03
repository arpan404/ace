import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { shell } from "electron";
import type { OpenInEditor } from "../../shared/contract.ts";

/** Opening these with the default handler would run them; reveal them instead. */
const executable = new Set([
  ".app",
  ".bat",
  ".cmd",
  ".com",
  ".command",
  ".exe",
  ".jar",
  ".lnk",
  ".msi",
  ".ps1",
  ".scr",
  ".sh",
  ".vbs",
]);

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
  if (
    !statSync(request.path).isDirectory() &&
    executable.has(extname(request.path).toLowerCase())
  ) {
    shell.showItemInFolder(request.path);
    return true;
  }
  return (await shell.openPath(request.path)) === "";
}

export function reveal(path: string): boolean {
  if (!existsSync(path)) return false;
  shell.showItemInFolder(path);
  return true;
}
