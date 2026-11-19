import { describe, expect, test } from "vitest";
import { helpUrl, issuesUrl, windowsHelpActions } from "./help-actions.ts";

/** A desktop bridge that records what it was asked to open and show. */
function desktop(platform: string) {
  const opened: string[] = [];
  let logsShown = 0;
  const scope = {
    ace: {
      platform,
      shell: { openExternal: async (url: string) => void opened.push(url) },
      daemon: {
        connection: async () => ({}),
        showLogs: async () => {
          logsShown++;
          return true;
        },
      },
    },
  };
  return { scope, opened, logsShown: () => logsShown };
}

describe.runIf(process.platform === "win32")("Help on Windows", () => {
  test("Help, Report an issue and Show logs do what the menu's items do", async () => {
    const app = desktop("win32");
    const actions = windowsHelpActions(app.scope) ?? [];
    expect(actions.map((action) => action.label)).toEqual(["Help", "Report an issue", "Show logs"]);
    for (const action of actions) await action.run();
    expect(app.opened).toEqual([helpUrl, issuesUrl]);
    expect(app.logsShown()).toBe(1);
  });

  test("macOS, Linux and a browser keep Help in their menus", () => {
    expect(windowsHelpActions(desktop("darwin").scope)).toBeUndefined();
    expect(windowsHelpActions(desktop("linux").scope)).toBeUndefined();
    expect(windowsHelpActions({})).toBeUndefined();
  });
});
