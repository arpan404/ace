import { defineWorkspace } from "@/lib/workspace/index.ts";

/**
 * A thread's side panel: Summary, Changes and Files (the checkout's tree) pinned; everything else
 * (terminals, Logs, a file, Browser, …) opens as a tab from the + launcher, a tool's shortcut or
 * Summary. Terminals open in the bottom panel instead unless the person chose the side. Only
 * these strings load with the thread screen; the kinds (icons, badges, loaders) follow once it
 * has painted.
 */
export const threadWorkspace = defineWorkspace({
  label: "Thread panel",
  launcher: "new-tab",
  // A phone has no room for the panel beside the conversation: Changes opens over it from ⋯.
  mobileTools: [{ label: "Changes", kind: "changes" }],
  // Terminals may also open under the conversation (Settings › General › Terminals open in).
  bottom: { label: "Terminal panel", kinds: ["terminal"] },
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
