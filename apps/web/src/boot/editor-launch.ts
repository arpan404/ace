/**
 * Hands an editor launch (ADR 0057: the daemon validates and returns it, never launches an
 * editor on a client's machine) to this machine. The desktop app opens it through its bridge;
 * a browser uses the editor's URL handler, which works when the daemon's paths are local.
 */
export interface LaunchTarget {
  /** The daemon's editor id (`code`, `cursor`, `zed`, `subl`, `idea`, ...). */
  editorId: string;
  editorName: string;
  path: string;
  line?: number | undefined;
}

/** The desktop bridge's editor ids (apps/desktop `EditorId`). */
const desktopEditors: Record<string, string> = {
  code: "vscode",
  cursor: "cursor",
  zed: "zed",
  idea: "idea",
  xcode: "xcode",
};

/** The editor's own URL handler, so no CLI needs to be on this machine's PATH. */
export function editorUrl(target: LaunchTarget): string | undefined {
  const path = encodeURI(target.path);
  const at = target.line ? `:${target.line}` : "";
  switch (target.editorId) {
    case "code":
      return `vscode://file${path}${at}`;
    case "cursor":
      return `cursor://file${path}${at}`;
    case "zed":
      return `zed://file${path}${at}`;
    case "subl":
      return `subl://open?url=${encodeURIComponent(`file://${target.path}`)}${target.line ? `&line=${target.line}` : ""}`;
    case "idea":
      return `idea://open?file=${encodeURIComponent(target.path)}${target.line ? `&line=${target.line}` : ""}`;
    default:
      return undefined;
  }
}

type OpenInEditor = (request: { path: string; editor?: string; line?: number }) => Promise<unknown>;

function desktopOpener(scope: object): OpenInEditor | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (typeof ace !== "object" || ace === null || !("shell" in ace)) return undefined;
  const shell: unknown = ace.shell;
  if (typeof shell !== "object" || shell === null || !("openInEditor" in shell)) return undefined;
  const open: unknown = shell.openInEditor;
  return typeof open === "function"
    ? (request) => Promise.resolve(Reflect.apply(open, shell, [request]))
    : undefined;
}

export async function launchEditor(target: LaunchTarget, scope: object = globalThis) {
  const desktop = desktopOpener(scope);
  if (desktop) {
    const editor = desktopEditors[target.editorId];
    const opened = await desktop({
      path: target.path,
      ...(editor ? { editor } : {}),
      ...(target.line ? { line: target.line } : {}),
    });
    if (opened === false) throw new Error(`${target.path} isn't on this computer.`);
    return;
  }
  const url = editorUrl(target);
  if (!url) throw new Error(`Open ${target.editorName} from the ace desktop app.`);
  // A registered URL handler opens the editor and leaves this page where it is.
  window.open(url, "_self");
}
