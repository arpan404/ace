import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "@/components/project-mark.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useOrganizerState } from "@/features/organize/index.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { usePreparations } from "./preparations.ts";
import { useDiscardDraft } from "./use-discard-draft.ts";

/**
 * Unsent preparations belong to this daemon and device, outside the running thread list.
 * Discard takes a row away at once, with Undo.
 */
export function DraftRows() {
  const identity = useHostIdentity();
  const host = identity?.hostId;
  const { storage } = useLayout();
  const { project } = useOrganizerState();
  const directory = useProjectDirectory();
  const discard = useDiscardDraft(storage, host ?? "");
  const [error, setError] = useState<string>();
  const rows = usePreparations(storage, host).filter(
    ([, row]) => !project || row.project === project,
  );
  if (!host || !rows.length) return null;
  return (
    <>
      <ul aria-label="Draft threads" className="pb-1">
        {rows.map(([key, row]) => (
          <li
            key={key}
            className="group/draft relative mb-1 rounded-md transition-colors duration-(--motion-fast) hover:bg-accent"
          >
            <Link
              data-row-focus=""
              to="/new"
              search={{
                project: row.project,
                skill: row.skill,
                issue: row.issue,
                pullRequest: row.pullRequest,
              }}
              aria-label={`${row.title}. Draft, Project ${directory.name(row.project)}`}
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
                <MachineMark icon={identity?.icon} />
                <span className="min-w-0 truncate">{identity?.displayName ?? "This machine"}</span>
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
