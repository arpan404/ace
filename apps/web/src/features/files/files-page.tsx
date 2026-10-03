import { DownloadSimpleIcon, FilesIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { PageTitle, Screen } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { fileStatus, formatAge, writtenText } from "@ace/ui-core";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { useFileStat } from "@/lib/diffs/use-file-diffs.ts";
import {
  uploadsThread,
  useChangedFiles,
  useUploadFile,
  useUploadsAvailable,
  type ChangedFile,
} from "./files-source.ts";
import { useProjectName } from "@/lib/projects.ts";

/** Hand a text file to the browser as a download. Boundary code: DOM and object URLs. */
function saveAs(name: string, text: string) {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
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
 * Files the agents changed in every thread, with download of what an agent created. The project picker
 * narrows the list; the text filter narrows it further by path.
 */
export function FilesPage() {
  const files = useChangedFiles();
  const uploads = useUploadsAvailable();
  const [filter, setFilter] = useState("");
  const [project, setProject] = useState(allProjects);
  const projectName = useProjectName();
  const text = filter.trim().toLowerCase();
  const projects = [...new Set((files.data ?? []).map((file) => file.workspaceId))].toSorted();
  const shown = (files.data ?? []).filter(
    (file) =>
      (project === allProjects || file.workspaceId === project) &&
      (!text ||
        file.path.toLowerCase().includes(text) ||
        projectName(file.workspaceId).toLowerCase().includes(text)),
  );
  return (
    <Screen
      title="Files"
      actions={
        files.data && (
          <div className="flex items-center gap-1.5">
            <Select
              label="Project"
              value={project}
              options={[
                { value: allProjects, label: "All projects" },
                ...projects.map((id) => ({ value: id, label: projectName(id) })),
              ]}
              onValueChange={setProject}
              className="h-[26px] min-w-32 text-[12px]"
            />
            {uploads && (
              <UploadButton
                projects={projects}
                project={project === allProjects ? undefined : project}
              />
            )}
          </div>
        )
      }
    >
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-(--column) px-8 pt-11 pb-20">
          <PageTitle title="Files" lede="Files the agents changed, in every thread and project." />
          <Input
            type="search"
            aria-label="Filter files"
            placeholder="Filter by path or project"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="mt-6 max-w-80"
          />
          {files.isError ? (
            <EmptyState
              icon={FilesIcon}
              title="Files unavailable"
              description={files.error.message}
            />
          ) : !files.data ? (
            <ListSkeleton label="files" shape="row" rows={6} className="mt-6" />
          ) : !shown.length ? (
            <EmptyState
              icon={FilesIcon}
              title={text || project !== allProjects ? "No files match" : "No changed files"}
              description="Files the agents change, in every thread, collect here."
            />
          ) : (
            groups(shown).map((group) => <ThreadFiles key={group[0]?.threadId} files={group} />)
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
        {first.threadId === uploadsThread.id ? (
          first.threadTitle
        ) : (
          <Link to="/t/$threadId" params={{ threadId: first.threadId }} className="hover:underline">
            {first.threadTitle}
          </Link>
        )}
        <small className="text-sm font-normal text-subtle-foreground">
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
  const status = fileStatus(file.changes);
  const written = writtenText(file);
  // Counted from the same diff the thread's Changes tab shows (off the main thread).
  const stat = useFileStat(file);
  return (
    <li className="flex items-center gap-3 border-t py-2 text-ui last:border-b">
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{file.path}</span>
      <span className="w-16 text-sm text-subtle-foreground">{statusWords[status]}</span>
      <span className="w-20 text-right font-mono text-[12px] tabular-nums">
        {/* Only the sides that changed: a new file reads +42, not +42 −0. */}
        {stat && stat.added > 0 && <span className="text-status-done">+{stat.added}</span>}
        {stat && stat.added > 0 && stat.removed > 0 && " "}
        {stat && stat.removed > 0 && <span className="text-status-failed">−{stat.removed}</span>}
      </span>
      <span className="w-8 text-right text-xs text-subtle-foreground">
        {formatAge(file.updatedAt, now)}
      </span>
      <IconButton
        icon={DownloadSimpleIcon}
        label={`Download ${file.path}`}
        size="sm"
        disabled={written === undefined}
        onClick={() => {
          if (written === undefined) return;
          const name = file.path.split("/").at(-1) ?? file.path;
          saveAs(name, written);
          toast.add({ title: `Downloaded ${name}` });
        }}
      />
    </li>
  );
}

/** Upload into the picked project, or choose one first when the list shows every project. */
function UploadButton(props: { projects: readonly string[]; project: string | undefined }) {
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string>();
  const upload = useUploadFile();
  const toast = useToast();
  const now = useNow();
  const projectName = useProjectName();
  const pick = (project: string) => {
    setTarget(project);
    input.current?.click();
  };
  const button = (
    <>
      <Icon icon={UploadSimpleIcon} size={14} />
      Upload
    </>
  );
  return (
    <>
      {props.project ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Upload to ${projectName(props.project)}`}
          onClick={() => pick(props.project ?? "")}
        >
          {button}
        </Button>
      ) : (
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="sm" />}>{button}</MenuTrigger>
          <MenuContent align="end" className="min-w-[180px]">
            {props.projects.map((id) => (
              <MenuItem key={id} onClick={() => pick(id)}>
                Upload to {projectName(id)}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
      <input
        ref={input}
        type="file"
        aria-label="File to upload"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          const workspaceId = target ?? props.project;
          if (!file || !workspaceId) return;
          upload.mutate(
            { workspaceId, file, now },
            {
              onSuccess: (path) =>
                toast.add({ title: `Uploaded ${path} to ${projectName(workspaceId)}` }),
              onError: (error) => toast.add({ title: error.message }),
            },
          );
        }}
      />
    </>
  );
}
