import { useClient, useConnectionState } from "@ace/client-react";
import { WorkspaceId, type PromptFile, type PromptFileScope } from "@ace/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { FileTextIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { promptProblem } from "./prompt-copy.ts";
import { Icon } from "@/components/icon.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { SettingsBody } from "./settings-body.tsx";
import { PromptEditor } from "./prompt-editor.tsx";

export function PromptsSettingsScreen() {
  const client = useClient(),
    online = useConnectionState() === "ready";
  const projects = useProjectDirectory();
  const [project, setProject] = useState("global");
  const [editing, setEditing] = useState<{ file?: PromptFile; scope: PromptFileScope }>();
  const [saved, setSaved] = useState<string>();
  const files = useQuery({
    queryKey: ["prompt-files", project],
    enabled: online,
    queryFn: async ({ signal }) => {
      const reply = await client.request(
        {
          type: "prompts.request",
          operation: {
            op: "list",
            ...(project !== "global" ? { workspaceId: WorkspaceId.parse(project) } : {}),
          },
        },
        { signal },
      );
      if (reply.result.kind !== "list")
        throw new Error(
          reply.result.kind === "error"
            ? reply.result.message
            : "Couldn't load prompts. Try again.",
        );
      return reply.result.files;
    },
  });
  const scope: PromptFileScope =
    project === "global"
      ? { kind: "global" }
      : { kind: "project", workspaceId: WorkspaceId.parse(project) };
  return (
    <SettingsBody
      page="Prompts"
      lede="Reusable prompt files, available from / in any conversation. Project prompts take precedence over global prompts."
    >
      <div className="mt-6 flex items-center justify-between gap-3">
        <Select
          label="Prompt location"
          value={project}
          options={[
            { value: "global", label: "Global" },
            ...projects.projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onValueChange={(value) => {
            setProject(value);
            setEditing(undefined);
            setSaved(undefined);
          }}
        />
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!online}
            onClick={() => {
              setSaved(undefined);
              setEditing({ scope });
            }}
          >
            New prompt
          </Button>
        )}
      </div>
      {!online && (
        <p role="status" className="mt-3 text-ui text-muted-foreground">
          Reconnect to load and edit your prompts.
        </p>
      )}
      {saved && (
        <p role="status" className="mt-3 text-ui text-muted-foreground">
          {saved}
        </p>
      )}
      {editing ? (
        <PromptEditor
          key={`${editing.file?.name ?? "new"}:${JSON.stringify(editing.scope)}`}
          {...editing}
          onClose={() => setEditing(undefined)}
          onSaved={(file) => {
            setSaved(
              file.diagnostics.length
                ? "Saved with errors. Open the prompt and fix the reported problems before using it."
                : "Prompt saved.",
            );
            setEditing(undefined);
            void files.refetch();
          }}
        />
      ) : files.isPending ? (
        online && <Spinner label="Loading prompts" />
      ) : files.isError ? (
        <p role="alert" className="mt-3 text-ui">
          {files.error.message}{" "}
          <Button size="sm" variant="ghost" onClick={() => void files.refetch()}>
            Try again
          </Button>
        </p>
      ) : !files.data.length ? (
        <p className="mt-6 text-ui text-muted-foreground">No prompt files here yet.</p>
      ) : (
        <ul aria-label="Prompt files" className="mt-4">
          {files.data.map((file) => (
            <li key={`${file.scope.kind}:${file.name}`}>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-ui hover:bg-accent focus-ring-inset"
                onClick={() => {
                  setEditing({ file, scope: file.scope });
                  setSaved(undefined);
                }}
              >
                <Icon icon={FileTextIcon} />
                <span className="min-w-0 truncate">{file.title}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
                  {file.description || file.name}
                </span>
                <span className="text-xs text-subtle-foreground">
                  {file.scope.kind === "global" ? "Global" : "Project"}
                </span>
                <span className="text-xs">Edit</span>
              </button>
              {!!file.diagnostics.length && (
                <p role="status" className="px-2 pb-2 text-xs text-status-failed">
                  {file.diagnostics
                    .map((diagnostic) => promptProblem(diagnostic.message))
                    .join(" ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsBody>
  );
}
