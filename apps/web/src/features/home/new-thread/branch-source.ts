// TODO(client-gaps): feat/client-protocol-gaps. Branches come from the workspace service, which
// has no client request on main, and thread.create carries no base branch yet. In fake mode the
// fake daemon's projects have branches; against a real daemon the list is empty and New thread
// hides the base-branch picker.
import { useQuery } from "@tanstack/react-query";
import { useDaemonConnection } from "@/boot/connection.tsx";

const branches: Record<string, string[]> = {
  ace: ["main", "fix/replay-dedupe", "deck/resumable-streams", "release/0.9"],
  "ace-mobile": ["main", "feat/haptics", "fix/sheet-rotate"],
  relay: ["main", "fix/restart-retry", "perf/fanout"],
  "billing-api": ["main", "fix/refund-tax", "fix/pdf-locale"],
  "docs-site": ["main", "docs/install-daemon"],
};

/** Branches a worktree can start from, default branch first; empty when unknown. */
export function useBranches(project: string | undefined): readonly string[] {
  const fake = useDaemonConnection().mode === "fake";
  return (
    useQuery({
      queryKey: ["new-thread", "branches", project],
      queryFn: async () => (fake ? (branches[project ?? ""] ?? ["main"]) : []),
      enabled: project !== undefined,
    }).data ?? []
  );
}
