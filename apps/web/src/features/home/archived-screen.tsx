import { useSidebarLoaded, useSidebarThread } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { formatAgo } from "@ace/ui-core";
import { ArchiveIcon, TrashIcon, TrayArrowUpIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import {
  useOrganizer,
  useOrganizerState,
  useOverlaidEntry,
  useThreadActions,
} from "@/features/organize/index.ts";
import { Page, PageTitle, Screen } from "@/features/shell/index.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { ThreadPagination } from "./thread-pagination.tsx";
import { useArchivedList } from "./use-home-threads.ts";

/**
 * The archive (QA-09): every archived thread, newest first, within Home's project filter, each
 * with Restore (back to Home on every device, with Undo) and Delete (asks first: a delete can't
 * be undone). Reached from the Threads heading's project menu and from ⌘K.
 */
export function ArchivedScreen() {
  const ids = useArchivedList();
  const loaded = useSidebarLoaded();
  const { project } = useOrganizerState();
  const organizer = useOrganizer();
  const projectName = useProjectName();
  const [deleting, setDeleting] = useState<ThreadListEntry>();
  const actions = useThreadActions();
  const scope = project === null ? undefined : projectName(project);
  return (
    <Screen title="Archived threads" subtitle={scope}>
      <Page>
        <PageTitle
          title="Archived"
          lede="Archived threads leave Home on every device and wait here. Restore one to bring it back, or delete it for good."
        />
        <div className="mt-6">
          {!loaded ? (
            <ListSkeleton label="archived threads" shape="row" />
          ) : ids.length === 0 ? (
            <EmptyState
              icon={ArchiveIcon}
              title={scope ? `Nothing archived in ${scope}` : "Nothing archived"}
              description="Archive a thread from its ⋯ menu or with ⇧⌘A; it waits here until you need it."
              action={
                scope ? (
                  <Button size="sm" variant="ghost" onClick={() => organizer.setProject(null)}>
                    Show all projects
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul aria-label="Archived threads" className="flex flex-col border-t">
              {ids.map((id) => (
                <ArchivedRow key={id} threadId={id} onDelete={setDeleting} />
              ))}
            </ul>
          )}
          <ThreadPagination />
        </div>
      </Page>
      {deleting && (
        <Dialog open onOpenChange={(open) => !open && setDeleting(undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete “{deleting.title}”?</DialogTitle>
              <DialogDescription>
                The thread and its history are removed from every device. This can't be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDeleting(undefined)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  actions.deleteArchived(deleting);
                  setDeleting(undefined);
                }}
              >
                Delete thread
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Screen>
  );
}

/** One archived thread: its title (opens it), project and when it was archived, and actions. */
function ArchivedRow(props: { threadId: string; onDelete(entry: ThreadListEntry): void }) {
  const entry = useOverlaidEntry(useSidebarThread(props.threadId));
  const actions = useThreadActions();
  const projectName = useProjectName();
  const now = useNow();
  if (!entry) return null;
  const archived = entry.archivedAt === undefined ? undefined : formatAgo(entry.archivedAt, now);
  return (
    <li className="flex min-w-0 items-center gap-3 border-b py-3">
      <div className="min-w-0 flex-1">
        <Link
          to="/t/$threadId"
          params={{ threadId: entry.id }}
          className="focus-ring block truncate rounded-xs text-ui font-medium text-foreground hover:underline"
        >
          {entry.title}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {projectName(entry.workspaceId)}
          {archived && ` · archived ${archived}`}
        </p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Restore ${entry.title}`}
        onClick={() => actions.restore(entry)}
      >
        <TrayArrowUpIcon aria-hidden size={14} />
        Restore
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Delete ${entry.title}`}
        onClick={() => props.onDelete(entry)}
      >
        <TrashIcon aria-hidden size={14} />
        <span className="max-sm:sr-only">Delete</span>
      </Button>
    </li>
  );
}
