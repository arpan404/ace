/**
 * Editors' own command-line launchers, read from the app catalogue (`open-apps.ts`): the names
 * the daemon looks for, and how a desktop app that runs one passes a file and position. One
 * table, so the launcher a daemon reports is exactly one a desktop app agrees to run.
 */
import { appLaunch, openApp, openApps, type OpenTarget } from "./open-apps.ts";

/** The launcher names to look for, preferred first; empty for an app without a CLI here. */
export function editorCommandNames(editorId: string): readonly string[] {
  return openApp(editorId)?.commands ?? [];
}

export type EditorTarget = OpenTarget;

/**
 * The arguments that open `target` with the launcher at `command`, judged by the launcher's file
 * name; undefined when it isn't a known editor launcher, so nothing else is ever run.
 */
export function editorCommandArgs(command: string, target: EditorTarget): string[] | undefined {
  const name = command.split(/[\\/]/).at(-1) ?? "";
  const editor = openApps.find((app) => app.kind === "editor" && app.commands.includes(name));
  return editor ? appLaunch(editor, command, target)?.args : undefined;
}
