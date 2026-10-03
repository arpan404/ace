import { DownloadSimpleIcon, FilesIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { PageTitle, Screen } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import {
  uploadsThread,
  useChangedFiles,
  useDownloadFile,
  useUploadFile,
  type ChangedFile,
} from "./files-source.ts";

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

/** Files the agents changed in every thread, with download and upload. */
export function FilesPage() {
  const files = useChangedFiles();
  const [filter, setFilter] = useState("");
  const text = filter.trim().toLowerCase();
  const shown = (files.data ?? []).filter(
    (file) => !text || file.path.toLowerCase().includes(text) || file.workspaceId.includes(text),
  );
  const projects = [...new Set((files.data ?? []).map((file) => file.workspaceId))].toSorted();
  return (
    <Screen title="Files" actions={files.data && <UploadButton projects={projects} />}>
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-[920px] px-8 pt-11 pb-20">
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
          ) : files.data && !shown.length ? (
            <EmptyState
              icon={FilesIcon}
              title={text ? "No files match" : "No changed files"}
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
        <small className="text-sm font-normal text-subtle-foreground">{first.workspaceId}</small>
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
  const download = useDownloadFile();
  const toast = useToast();
  return (
    <li className="flex items-center gap-3 border-t py-2 text-ui last:border-b">
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{file.path}</span>
      <span className="w-16 text-sm text-subtle-foreground">{file.change}</span>
      <span className="w-20 text-right font-mono text-[12px] tabular-nums">
        <span className="text-status-done">+{file.additions}</span>{" "}
        <span className="text-status-failed">−{file.deletions}</span>
      </span>
      <span className="w-8 text-right text-xs text-subtle-foreground">
        {formatAge(file.updatedAt, now)}
      </span>
      <IconButton
        icon={DownloadSimpleIcon}
        label={`Download ${file.path}`}
        size="sm"
        disabled={file.change === "deleted"}
        onClick={() =>
          download.mutate(file, {
            onSuccess: (result) => {
              saveAs(result.name, result.text);
              toast.add({ title: `Downloaded ${result.name}` });
            },
            onError: (error) => toast.add({ title: error.message }),
          })
        }
      />
    </li>
  );
}

function UploadButton(props: { projects: readonly string[] }) {
  const input = useRef<HTMLInputElement>(null);
  const [project, setProject] = useState(props.projects[0] ?? "");
  const upload = useUploadFile();
  const toast = useToast();
  const now = useNow();
  return (
    <div className="flex items-center gap-1.5">
      <Select
        label="Upload to project"
        value={project || props.projects[0] || ""}
        options={props.projects.map((id) => ({ value: id, label: id }))}
        onValueChange={setProject}
        className="h-[26px] min-w-28 text-[12px]"
      />
      <Button variant="ghost" size="sm" onClick={() => input.current?.click()}>
        <Icon icon={UploadSimpleIcon} size={14} />
        Upload
      </Button>
      <input
        ref={input}
        type="file"
        aria-label="File to upload"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          upload.mutate(
            { workspaceId: project || props.projects[0] || "", file, now },
            {
              onSuccess: (path) => toast.add({ title: `Uploaded ${path}` }),
              onError: (error) => toast.add({ title: error.message }),
            },
          );
        }}
      />
    </div>
  );
}
