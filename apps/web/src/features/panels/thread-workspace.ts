import { defineWorkspace } from "@/lib/workspace/index.ts";

/**
 * A thread's workspace: Changes and Agents beside the conversation, Terminal and Logs below, all
 * pinned; everything else opens from the + launcher or a tool's shortcut. Only these strings load
 * with the thread screen; the kinds (icons, badges, loaders) follow once it has painted.
 */
export const threadWorkspace = defineWorkspace({
  label: "Thread panel",
  docks: ["right", "bottom"],
  launcher: "new-tab",
  initial: [
    { kind: "changes", dock: "right", pinned: true },
    { kind: "agents", dock: "right", pinned: true },
    { kind: "terminal", dock: "bottom", pinned: true },
    { kind: "logs", dock: "bottom", pinned: true },
  ],
  shortcuts: {
    changes: "changes",
    terminal: "terminal",
    files: "files",
    "side-chat": "sideChat",
    preview: "preview",
    devices: "devices",
    agents: "agents",
    logs: "logs",
  },
  kinds: () => import("./thread-kinds.tsx"),
});
