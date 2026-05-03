import type { OrchestrationProject, OrchestrationThread } from "@ace/contracts";
import type { HostInstance } from "../hostInstances";
import type { MobileProjectSummary, MobileThreadSummary } from "../orchestration/mobileData";

export type MobileQuickSearchItem =
  | {
      readonly kind: "action";
      readonly id: string;
      readonly title: string;
      readonly subtitle: string;
      readonly target: "pairing" | "projects" | "settings";
    }
  | {
      readonly kind: "host";
      readonly id: string;
      readonly title: string;
      readonly subtitle: string;
      readonly hostId: string;
      readonly connected: boolean;
    }
  | {
      readonly kind: "project";
      readonly id: string;
      readonly title: string;
      readonly subtitle: string;
      readonly hostId: string;
      readonly projectId: OrchestrationProject["id"];
    }
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly title: string;
      readonly subtitle: string;
      readonly hostId: string;
      readonly threadId: OrchestrationThread["id"];
      readonly projectId: OrchestrationThread["projectId"];
    };

function matchesQuery(parts: ReadonlyArray<string | null | undefined>, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  return parts.join(" ").toLowerCase().includes(normalizedQuery);
}

const MOBILE_QUICK_ACTIONS: ReadonlyArray<
  Extract<MobileQuickSearchItem, { readonly kind: "action" }>
> = [
  {
    kind: "action",
    id: "action:pairing",
    title: "Pair host",
    subtitle: "Connect a desktop ace host",
    target: "pairing",
  },
  {
    kind: "action",
    id: "action:projects",
    title: "Open projects",
    subtitle: "Browse workspaces and create project roots",
    target: "projects",
  },
  {
    kind: "action",
    id: "action:settings",
    title: "Open settings",
    subtitle: "Tune mobile and host preferences",
    target: "settings",
  },
];

export function buildMobileQuickSearchItems({
  connectedHostIds,
  hosts,
  projects,
  query,
  threads,
}: {
  readonly connectedHostIds: ReadonlySet<string>;
  readonly hosts: ReadonlyArray<HostInstance>;
  readonly projects: ReadonlyArray<MobileProjectSummary>;
  readonly query: string;
  readonly threads: ReadonlyArray<MobileThreadSummary>;
}): ReadonlyArray<MobileQuickSearchItem> {
  const actionItems = MOBILE_QUICK_ACTIONS.filter((action) =>
    matchesQuery([action.title, action.subtitle], query),
  );

  const hostItems = hosts
    .filter((host) => matchesQuery([host.name, host.wsUrl], query))
    .map<MobileQuickSearchItem>((host) => ({
      kind: "host",
      id: `host:${host.id}`,
      title: host.name,
      subtitle: connectedHostIds.has(host.id) ? "Connected host" : "Offline host",
      hostId: host.id,
      connected: connectedHostIds.has(host.id),
    }));

  const projectItems = projects
    .filter((entry) =>
      matchesQuery([entry.project.title, entry.project.workspaceRoot, entry.hostName], query),
    )
    .map<MobileQuickSearchItem>((entry) => ({
      kind: "project",
      id: `project:${entry.hostId}:${entry.project.id}`,
      title: entry.project.title,
      subtitle: `${entry.hostName} · ${entry.project.workspaceRoot}`,
      hostId: entry.hostId,
      projectId: entry.project.id,
    }));

  const threadItems = threads
    .filter((entry) =>
      matchesQuery(
        [
          entry.thread.title,
          entry.preview,
          entry.projectTitle,
          entry.hostName,
          entry.thread.branch,
          entry.thread.worktreePath,
        ],
        query,
      ),
    )
    .map<MobileQuickSearchItem>((entry) => ({
      kind: "thread",
      id: `thread:${entry.hostId}:${entry.thread.id}`,
      title: entry.thread.title,
      subtitle: `${entry.status.label} · ${entry.projectTitle} · ${entry.hostName}`,
      hostId: entry.hostId,
      threadId: entry.thread.id,
      projectId: entry.thread.projectId,
    }));

  return [...actionItems, ...hostItems, ...projectItems, ...threadItems].slice(0, 60);
}
