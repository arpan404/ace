import type { Fact } from "@ace/core";
import type { Scenario } from "../scenario.ts";
import { aceCall, screenAudit } from "./ace-tools.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

/*
 * Computer use in the background, as Claude Code records it: list the apps, look at Calculator,
 * then batches of actions in it and in TextEdit, one with a menu step that fails. Each call has
 * the daemon's `screen.step` audit beside it, named for the tool as newer daemons write it.
 */

const text = (value: string) => [{ type: "text" as const, text: value }];
const calculator = "com.apple.calculator";
const textEdit = "com.apple.TextEdit";

const outline = [
  'Calculator — window "Calculator"',
  '1. button "All Clear"',
  '2. button "7"',
  '3. button "Add"',
  '4. button "Equals"',
  '5. text "0"',
].join("\n");

/** An agent working Calculator and TextEdit through `screen_apps`, `screen_state`, `screen_act`. */
export function aceToolsComputerBackground(): Scenario {
  const facts: Fact[] = [
    rootAgent("claude"),
    turn("root"),
    message("root", "ask", "user", "Add 7 and 7 in Calculator, then note the answer in TextEdit."),
    aceCall("root", "apps", "screen_apps", {}, text("Running: Calculator, TextEdit, Safari")),
    aceCall("root", "state", "screen_state", { app: "Calculator" }, text(outline)),
    screenAudit("root", "state-audit", "screen_state", calculator, "background", "completed"),
    aceCall(
      "root",
      "sum",
      "screen_act",
      {
        app: "Calculator",
        actions: [
          { type: "click", id: 1 },
          { type: "type", text: "7+7" },
          { type: "key", key: "Return" },
        ],
      },
      text(
        '1. pressed 1 button "All Clear"\n2. typed 3 characters\n3. pressed Return\n5. text "14"',
      ),
    ),
    screenAudit("root", "sum-audit", "screen_act", calculator, "background", "completed"),
    aceCall(
      "root",
      "new",
      "screen_act",
      { app: textEdit, actions: [{ type: "menu", path: ["File", "New"] }] },
      text("1. chose File › New"),
    ),
    screenAudit("root", "new-audit", "screen_act", textEdit, "background", "completed"),
    aceCall(
      "root",
      "export",
      "screen_act",
      { app: textEdit, actions: [{ type: "menu", path: ["File", "Export as PDF…"] }] },
      text('Action 1 (menu) failed: no menu item "Export as PDF…" under File'),
      true,
    ),
    screenAudit("root", "export-audit", "screen_act", textEdit, "background", "failed"),
    message("root", "answer", "assistant", "7 + 7 is 14; I opened a new TextEdit document."),
  ];
  return {
    thread: {
      id: "thread-ace-tools-background",
      workspaceId: "ace",
      title: "Add numbers in Calculator",
      provider: "claude",
    },
    steps: [
      ...facts.map((fact, index) => ({
        kind: "facts" as const,
        facts: [fact],
        agoMs: Math.round((30_000 * (facts.length - index)) / facts.length),
      })),
      { kind: "facts", label: "used-apps", facts: [endTurn("root")] },
    ],
  };
}
