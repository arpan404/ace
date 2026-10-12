import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useClient } from "@ace/client-react";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useOrganizerState } from "@/features/organize/index.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { preparations, usePreparationsChanged } from "./preparations.ts";
import { discardPreparation } from "./discard-preparation.ts";

/** Unsent preparations belong to this daemon and device, outside the running thread list. */
export function DraftRows() {
  const host = useHostIdentity()?.hostId;
  const { storage } = useLayout();
  const { project } = useOrganizerState();
  const directory = useProjectDirectory();
  const client = useClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  usePreparationsChanged();
  const rows = host
    ? preparations(storage, host).filter(([, row]) => !project || row.project === project)
    : [];
  if (!host || !rows.length) return null;
  return (
    <>
      <ul aria-label="Draft threads" className="px-2 pb-1">
        {rows.map(([key, row]) => (
          <li key={key} className="flex items-center rounded-md hover:bg-sidebar-accent">
            <Link
              to="/new"
              search={{ project: row.project, skill: row.skill }}
              aria-label={`${row.title}. Draft, Project ${directory.name(row.project)}`}
              className="flex min-w-0 flex-1 flex-col gap-1 rounded-md px-2 py-3 text-ui focus-ring-inset"
            >
              <span className="flex justify-between text-xs text-muted-foreground">
                <span>{directory.name(row.project)}</span>
                <span>Draft</span>
              </span>
              <span className="truncate">{row.title}</span>
            </Link>
            <button
              type="button"
              aria-label={`Discard draft in ${directory.name(row.project)}`}
              className="mr-2 px-2 py-1 text-xs text-muted-foreground focus-ring hover:text-foreground"
              onClick={() => {
                setError(undefined);
                if (!discardPreparation(storage, host, key)) {
                  setError(
                    "Couldn't discard the draft on this device. Your saved work and files are kept. Free space and try again.",
                  );
                  return;
                }
                // Remount an open preparation so its in-memory content cannot recreate the discarded row.
                void navigate({
                  to: "/new",
                  search: (previous) => ({
                    project: row.project,
                    skill: row.skill,
                    discard: (previous.discard ?? 0) + 1,
                  }),
                });
                if (row.draftId) {
                  void client
                    .request({
                      type: "context.request",
                      operation: { op: "draft.release", draftId: row.draftId },
                    })
                    .catch(() => {
                      // The unreferenced scope expires even when this device cannot release it.
                    });
                }
              }}
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
