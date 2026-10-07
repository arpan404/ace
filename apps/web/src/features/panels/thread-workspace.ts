import { defineWorkspace } from "@/lib/workspace/index.ts";

/**
 * A thread's side panel: Changes and Agents pinned; everything else (terminals, Logs, Files,
 * Browser, …) opens as a tab from the + launcher, a tool's shortcut or the work card. Only these
 * strings load with the thread screen; the kinds (icons, badges, loaders) follow once it has
 * painted.
 */
export const threadWorkspace = defineWorkspace({
  label: "Thread panel",
  launcher: "new-tab",
  initial: [
    { kind: "changes", pinned: true },
    { kind: "agents", pinned: true },
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
