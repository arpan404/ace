import { desktopDaemon } from "./desktop.ts";
import { openExternal } from "./open-external.ts";

/** ace's public repository: its README is the guide, its issues the place to report one. */
const repositoryUrl = "https://github.com/arpan404/ace";
export const helpUrl = `${repositoryUrl}#readme`;
export const issuesUrl = `${repositoryUrl}/issues`;

export interface HelpAction {
  id: "help" | "report-issue" | "show-logs";
  label: string;
  run(): Promise<void>;
}

/**
 * The desktop menu's Help items for the Windows app, whose frameless window shows no menu bar:
 * Help, Report an issue and Show logs, for Settings and the command palette. Undefined anywhere
 * else (macOS and Linux keep them in the menu; a browser has no logs to show).
 */
export function windowsHelpActions(scope: object = globalThis): readonly HelpAction[] | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (!ace || typeof ace !== "object" || Reflect.get(ace, "platform") !== "win32") return undefined;
  const showLogs = desktopDaemon(scope)?.showLogs;
  return [
    { id: "help", label: "Help", run: () => openExternal(helpUrl, scope) },
    { id: "report-issue", label: "Report an issue", run: () => openExternal(issuesUrl, scope) },
    ...(showLogs
      ? [{ id: "show-logs", label: "Show logs", run: async () => void (await showLogs()) } as const]
      : []),
  ];
}
