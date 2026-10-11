import { defineWorkspace } from "@/lib/workspace/index.ts";

/** The shell owns the PR tab strip, launcher, docking, resizing and full view. */
export const prWorkspace = defineWorkspace({
  label: "Pull request workspace",
  launcher: "pr-new",
  initial: [],
  dockable: true,
  kinds: () => import("./pr-panel-kinds.tsx"),
});
