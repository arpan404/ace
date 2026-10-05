import { CaretRightIcon, DownloadSimpleIcon, FilesIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { PageTitle, Screen } from "@/features/shell/index.ts";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { fileStatus, formatAge, writtenText } from "@ace/ui-core";
import { useFileStat } from "@/lib/diffs/use-file-diffs.ts";
import {
  DownloadTooLarge,
  threadLimit,
  useChangedFiles,
  useDownloadFile,
  type ChangedFile,
} from "./files-source.ts";

/** Hand a blob to the browser as a download. Boundary code: DOM and object URLs. */
function saveAs(name: string, blob: Blob) {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function groups(files: readonly ChangedFile[]) {
  const byThread = new Map<string, ChangedFile[]>();
  for (const file of files)
    byThread.set(file.threadId, [...(byThread.get(file.threadId) ?? []), file]);
  return [...byThread.values()];
}

const allProjects = "\u0000all";
const statusWords = { added: "added", deleted: "deleted", moved: "renamed", modified: "modified" };

/**
 * Files the agents changed in every thread, each opening its thread and downloading as it is
 * now. The project picker narrows the list; the filter narrows it further by path.
 */
export function FilesPage() {
  const files = useChangedFiles();
  const [filter, setFilter] = useState("");
  const [project, setProject] = useState(allProjects);
  const projectName = useProjectName();
  const text = filter.trim().toLowerCase();
  const all = files.data?.files ?? [];
  const projects = [...new Set(all.map((file) => file.workspaceId))].toSorted();
  const shown = all.filter(
    (file) =>
      (project === allProjects || file.workspaceId === project) &&
      (!text ||
        file.path.toLowerCase().includes(text) ||
        projectName(file.workspaceId).toLowerCase().includes(text)),
  );
  const narrowed = text.length > 0 || project !== allProjects;
  return (
    <Screen
      title="Files"
      actions={
        files.data && (
          <div className="flex items-center gap-2">
            {files.isFetching && <Spinner label="Updating files" />}
            <Select
              label="Project"
              value={project}
              options={[
                { value: allProjects, label: "All projects" },
                ...projects.map((id) => ({ value: id, label: projectName(id) })),
              ]}
              onValueChange={setProject}
              className="h-7"
            />
          </div>
        )
      }
    >
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-(--column) px-4 pt-6 pb-20 sm:px-8 sm:pt-11">
          <PageTitle title="Files" lede="Files the agents changed, in every thread and project." />
          <SearchField
            label="Filter files"
            placeholder="Filter by path or project"
            value={filter}
            onValueChange={setFilter}
            className="mt-6 max-w-80"
          />
          {files.isError ? (
            <EmptyState
              icon={FilesIcon}
              title="Files unavailable"
              description={describeDaemonError(daemonErrorCode(files.error))}
              action={
                <Button size="sm" onClick={() => void files.refetch()}>
                  Try again
                </Button>
              }
              className="h-auto pt-16"
            />
          ) : !files.data ? (
            <ListSkeleton label="files" shape="row" rows={6} className="mt-6" />
          ) : !shown.length ? (
            narrowed ? (
              <EmptyState
                icon={FilesIcon}
                title="No files match"
                description={text ? `No files match "${filter.trim()}".` : undefined}
                action={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setFilter("");
                      setProject(allProjects);
                    }}
                  >
                    Clear filter
                  </Button>
                }
                className="h-auto pt-16"
              />
            ) : (
              <EmptyState
                icon={FilesIcon}
                title="No changed files"
                description="Files the agents change, in every thread, collect here."
                className="h-auto pt-16"
              />
            )
          ) : (
            <>
              {groups(shown).map((group) => (
                <ThreadFiles key={group[0]?.threadId} files={group} />
              ))}
              {files.data.capped && (
                <p className="mt-6 text-sm text-muted-foreground">
                  Showing files from the {threadLimit} most recent threads.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}

function ThreadFiles(props: { files: readonly ChangedFile[] }) {
  const projectName = useProjectName();
  const first = props.files[0];
  if (!first) return null;
  return (
    <section aria-label={first.threadTitle} className="mt-7">
      <h2 className="flex items-baseline gap-2 text-md font-medium">
        <Link
          to="/t/$threadId"
          params={{ threadId: first.threadId }}
          className="inline-flex items-center gap-1 rounded-sm text-foreground hover:underline focus-ring"
        >
          {first.threadTitle}
          <Icon icon={CaretRightIcon} size={12} className="text-muted-foreground" />
        </Link>
        <small className="text-sm font-normal text-muted-foreground">
          {projectName(first.workspaceId)}
        </small>
      </h2>
      <ul className="mt-2.5">
        {props.files.map((file) => (
          <FileRow key={file.path} file={file} />
        ))}
      </ul>
    </section>
  );
}

function FileRow(props: { file: ChangedFile }) {
  const { file } = props;
  const now = useNow();
  const toast = useToast();
  const download = useDownloadFile();
  const [busy, setBusy] = useState(false);
  const status = fileStatus(file.changes);
  const written = writtenText(file);
  // Counted from the same diff the thread's Changes tab shows (off the main thread).
  const stat = useFileStat(file);
  const name = file.path.split("/").at(-1) ?? file.path;
  const deleted = status === "deleted";
  const save = async () => {
    setBusy(true);
    try {
      // What the agent wrote whole is already here; anything else comes from the checkout.
      saveAs(name, written === undefined ? await download(file) : new Blob([written]));
      toast.add({ title: `Downloaded ${name}` });
    } catch (error) {
      toast.error({
        title: `Couldn't download ${name}`,
        description:
          error instanceof DownloadTooLarge
            ? error.message
            : describeDaemonError(daemonErrorCode(error)),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="relative flex items-center gap-3 border-t px-1 py-2 text-ui last:border-b hover:bg-accent">
      <Link
        to="/t/$threadId"
        params={{ threadId: file.threadId }}
        title={file.path}
        className="min-w-0 flex-1 truncate rounded-xs font-mono text-sm focus-ring after:absolute after:inset-0"
      >
        {file.path}
      </Link>
      <span className="w-16 shrink-0 text-sm text-muted-foreground max-sm:hidden">
        {statusWords[status]}
      </span>
      <span className="w-20 shrink-0 text-right font-mono text-sm tabular-nums">
        {/* Only the sides that changed: a new file reads +42, not +42 −0. */}
        {!stat ? (
          <Skeleton className="ml-auto h-3 w-16" />
        ) : (
          <>
            {stat.added > 0 && <span className="text-status-done">+{stat.added}</span>}
            {stat.added > 0 && stat.removed > 0 && " "}
            {stat.removed > 0 && <span className="text-status-failed">−{stat.removed}</span>}
          </>
        )}
      </span>
      <span className="w-8 shrink-0 text-right text-xs text-muted-foreground max-sm:hidden">
        {formatAge(file.updatedAt, now)}
      </span>
      {deleted ? (
        <Tip label="Deleted in this thread">
          <span tabIndex={0} className="relative rounded-sm focus-ring">
            <IconButton
              icon={DownloadSimpleIcon}
              label={`Download ${file.path}`}
              size="sm"
              tooltip={false}
              disabled
            />
          </span>
        </Tip>
      ) : (
        <IconButton
          icon={DownloadSimpleIcon}
          label={`Download ${file.path}`}
          size="sm"
          className="relative"
          disabled={busy}
          onClick={() => void save()}
        />
      )}
    </li>
  );
}
