import { defineWorkspace } from "@/lib/workspace/index.ts";

/**
 * A thread's workspace: Changes and Agents pinned beside the conversation, a terminal and Logs
 * below; everything else opens from the + launcher or a tool's shortcut. Only these strings load
 * with the thread screen; the kinds (icons, badges, loaders) follow once it has painted.
 */
export const threadWorkspace = defineWorkspace({
  label: "Thread panel",
  docks: ["right", "bottom"],
  launcher: "new-tab",
  initial: [
    { kind: "changes", dock: "right", pinned: true },
    { kind: "agents", dock: "right", pinned: true },
    // A terminal that starts (or picks up a spare shell) the first time the bottom panel shows.
    { kind: "terminal", dock: "bottom" },
    { kind: "logs", dock: "bottom" },
  ],
  shortcuts: {
    changes: "changes",
    terminal: "terminal",
    files: "files",
    "side-chat": "sideChat",
    browser: "browser",
    preview: "preview",
    devices: "devices",
    agents: "agents",
    logs: "logs",
  },
  kinds: () => import("./thread-kinds.tsx"),
});
