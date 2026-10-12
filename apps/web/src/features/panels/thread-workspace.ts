import { defineWorkspace } from "@/lib/workspace/index.ts";

/**
 * A thread's side panel: Work, Changes and Files (the checkout's tree) pinned; everything else
 * (terminals, Logs, a file, Browser, …) opens as a tab from the + launcher, a tool's shortcut or
 * Work. Only these strings load with the thread screen; the kinds (icons, badges,
 * loaders) follow once it has painted.
 */
export const threadWorkspace = defineWorkspace({
  label: "Thread panel",
  launcher: "new-tab",
  mobileAction: { label: "Work", kind: "work" },
  initial: [
    { kind: "work", pinned: true },
    { kind: "changes", pinned: true },
    { kind: "files", pinned: true },
  ],
  shortcuts: {
    changes: "changes",
    terminal: "terminal",
    files: "files",
    browser: "browser",
    preview: "preview",
    devices: "devices",
    work: "agents",
    logs: "logs",
  },
  kinds: () => import("./thread-kinds.tsx"),
});
