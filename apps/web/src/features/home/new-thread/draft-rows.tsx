import type { MachineIcon } from "@ace/protocol";
import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "@/components/project-mark.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useLayout } from "@/lib/layout.tsx";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { useMachines } from "@/lib/machines.ts";
import { useOrganizerState } from "@/features/organize/index.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { usePreparations } from "./preparations.ts";
import { useDiscardDraft } from "./use-discard-draft.ts";
import { useSidebarDevice } from "../device-filter-state.ts";

/**
 * Unsent preparations belong to a daemon and this device, outside the running thread list:
 * this window's own, then each other connected machine's (ADR 0102), each row marked with its
 * machine and reopening on it. Discard takes a row away at once, with Undo.
 */
export function DraftRows() {
  const identity = useHostIdentity();
  const device = useSidebarDevice();
  const others = useMachines().filter(
    (machine) => !machine.primary && machine.client && (!device || machine.id === device),
  );
  return (
    <>
      {identity && (!device || device === identity.hostId) && (
        <MachineDrafts
          host={identity.hostId}
          name={identity.displayName ?? "This machine"}
          icon={identity.icon}
        />
      )}
      {others.map((machine) => (
        <MachineScope key={machine.id} machine={machine}>
          <MachineDrafts host={machine.id} name={machine.name} icon={machine.icon} remote />
        </MachineScope>
      ))}
    </>
  );
}

/** One machine's drafts, read and discarded under its own client. */
function MachineDrafts(props: {
  host: string;
  name: string;
  icon: MachineIcon | undefined;
  remote?: boolean;
}) {
  const { storage } = useLayout();
  const { project } = useOrganizerState();
  const directory = useProjectDirectory();
  const discard = useDiscardDraft(storage, props.host);
  const machine = useMachineSearch();
  const [error, setError] = useState<string>();
  const rows = usePreparations(storage, props.host).filter(
    ([, row]) => !project || row.project === project,
  );
  if (!rows.length) return null;
  return (
    <>
      <ul
        aria-label={props.remote ? `Draft threads on ${props.name}` : "Draft threads"}
        className="pb-1"
      >
        {rows.map(([key, row]) => (
          <li
            key={key}
            className="group/draft relative mb-1 rounded-md transition-colors duration-(--motion-fast) hover:bg-accent"
          >
            <Link
              data-row-focus=""
              to="/new"
              search={{
                ...machine,
                project: row.project,
                ...(row.from ? { from: row.from } : {}),
                skill: row.skill,
                issue: row.issue,
                pullRequest: row.pullRequest,
              }}
              aria-label={`${row.title}. Draft, Project ${directory.name(row.project)}${props.remote ? `, on ${props.name}` : ""}`}
              className="flex h-20 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md px-2.5 py-3 text-ui focus-ring-inset"
            >
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ProjectMark
                  id={row.project}
                  badge={projectBadge({ id: row.project, name: directory.name(row.project) })}
                />
                <span className="min-w-0 flex-1 truncate">{directory.name(row.project)}</span>
                <span>Draft</span>
              </span>
              <span className="truncate text-base leading-5 text-foreground">{row.title}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MachineMark icon={props.icon} primary={!props.remote} />
                <span className="min-w-0 truncate">{props.name}</span>
                {row.provider && (
                  <ProviderIcon provider={row.provider} size={14} className="ml-auto" decorative />
                )}
              </span>
            </Link>
            <button
              type="button"
              aria-label={`Discard draft in ${directory.name(row.project)}`}
              className="absolute right-2 bottom-2 rounded-sm bg-sidebar px-2 py-1 text-xs text-muted-foreground opacity-0 focus-ring group-hover/draft:opacity-100 group-focus-within/draft:opacity-100 hover:text-foreground pointer-coarse:opacity-100"
              onClick={() => setError(discard(key, row))}
            >
              Discard
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="px-4 text-xs text-status-failed">
          {error}
        </p>
      )}
    </>
  );
}
