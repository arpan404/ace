import { useClient, useConnectionState } from "@ace/client-react";
import { TrashIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { addProjectRoot, saveProjectRoots } from "@/lib/project-roots.ts";

export function ProjectFolders() {
  const client = useClient();
  const [roots] = useDaemonSetting("projects.roots");
  const offline = useConnectionState() !== "ready";
  const query = useQueryClient();
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const run = async (write: () => Promise<void>) => {
    setPending(true);
    setProblem(undefined);
    try {
      await write();
      setPath("");
      await query.invalidateQueries({ queryKey: ["projects", "folders"] });
    } catch {
      setProblem("Couldn't save this folder. Use its full path and try again.");
    } finally {
      setPending(false);
    }
  };
  const disabled = offline || pending || roots === undefined;
  return (
    <SettingSection label="Project folders" anchor="projects.roots" scope="daemon">
      <p className="mb-2 text-sm text-muted-foreground">
        ace can open projects inside these folders. With no folders added, your home folder is
        allowed.
      </p>
      <ul aria-label="Project folders">
        {(roots ?? []).map((root) => (
          <li key={root} className="flex min-h-9 items-center gap-2 text-ui">
            <span className="min-w-0 flex-1 truncate" title={root}>
              {root}
            </span>
            <IconButton
              icon={TrashIcon}
              label={`Remove ${root}`}
              size="sm"
              disabled={disabled}
              onClick={() =>
                void run(() =>
                  saveProjectRoots(
                    client,
                    (roots ?? []).filter((value) => value !== root),
                  ),
                )
              }
            />
          </li>
        ))}
      </ul>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => addProjectRoot(client, path.trim()));
        }}
      >
        <Input
          aria-label="Folder path"
          placeholder="Full folder path"
          value={path}
          className="min-w-0 flex-1"
          onChange={(event) => setPath(event.target.value)}
          disabled={disabled}
        />
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          disabled={disabled || !/^(?:\/|[A-Za-z]:[\\/])/.test(path.trim())}
        >
          Add folder
        </Button>
      </form>
      {problem && (
        <p role="alert" className="mt-1 text-sm text-status-failed">
          {problem}
        </p>
      )}
    </SettingSection>
  );
}
