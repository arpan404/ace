/**
 * Editors' own command-line launchers: the names the daemon looks for when it lists installed
 * editors, and how a desktop app that runs one passes a file and position. One table, so the
 * launcher a daemon reports is exactly one a desktop app agrees to run.
 */

/** How a launcher takes a position. */
type PositionStyle = "goto" | "suffix" | "line-flag";

interface EditorCommands {
  /** Launcher file names, preferred first: PATH names, then Linux package aliases. */
  names: readonly string[];
  position: PositionStyle;
}

const editors: Readonly<Record<string, EditorCommands>> = {
  code: {
    names: ["code", "code-insiders", "codium", "com.visualstudio.code", "com.vscodium.codium"],
    position: "goto",
  },
  cursor: { names: ["cursor"], position: "goto" },
  zed: { names: ["zed", "zeditor", "dev.zed.Zed"], position: "suffix" },
  subl: { names: ["subl", "sublime-text.subl", "com.sublimetext.three"], position: "suffix" },
  idea: {
    names: [
      "idea",
      "idea.sh",
      "intellij-idea-ultimate",
      "intellij-idea-community",
      "com.jetbrains.IntelliJ-IDEA-Ultimate",
      "com.jetbrains.IntelliJ-IDEA-Community",
    ],
    position: "line-flag",
  },
};

/** The launcher names to look for, preferred first; empty for an editor without a CLI here. */
export function editorCommandNames(editorId: string): readonly string[] {
  return Object.hasOwn(editors, editorId) ? (editors[editorId]?.names ?? []) : [];
}

export interface EditorTarget {
  path: string;
  line?: number | undefined;
  column?: number | undefined;
}

/**
 * The arguments that open `target` with the launcher at `command`, judged by the launcher's file
 * name; undefined when it isn't a known editor launcher, so nothing else is ever run.
 */
export function editorCommandArgs(command: string, target: EditorTarget): string[] | undefined {
  const name = command.split(/[\\/]/).at(-1) ?? "";
  const editor = Object.values(editors).find((entry) => entry.names.includes(name));
  if (!editor) return undefined;
  const { path, line, column } = target;
  if (!line) return [path];
  const at = `${path}:${line}${column ? `:${column}` : ""}`;
  switch (editor.position) {
    case "goto":
      return ["-g", at];
    case "suffix":
      return [at];
    case "line-flag":
      return ["--line", String(line), ...(column ? ["--column", String(column)] : []), path];
  }
}
