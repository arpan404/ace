import type { ForgeRepository } from "@ace/protocol";
import { pullRequestTab } from "@/features/panels/index.ts";
import type { harness } from "@/test/harness.tsx";

/** The thread whose side panel shows the pull request: the tab names its own project. */
const host = "thread-retry-budget";

/**
 * Open pull request `number` of `project` in a thread's side panel, full view, as clicking the
 * thread's PR line leaves it (the panel remembers its tabs in this device's storage).
 */
export function openPullRequest(
  app: ReturnType<typeof harness>,
  pr: { project: string; repository?: ForgeRepository; number: number },
) {
  const tab = pullRequestTab({
    workspaceId: pr.project,
    repository: pr.repository,
    number: pr.number,
  });
  const key = `${tab.kind}:${tab.id}`;
  const stored = {
    tabs: [{ key, kind: tab.kind, id: tab.id, title: tab.title, pinned: false, data: tab.data }],
    active: key,
    open: true,
    expanded: true,
  };
  app.storage.setItem(
    "ace.workspace",
    JSON.stringify({ preferred: { right: 520 }, scopes: [[host, stored]] }),
  );
  return app.open(`/t/${host}`);
}
