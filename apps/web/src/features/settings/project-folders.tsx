import { useClient, useConnectionState } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingSection, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { RowMenu } from "@/components/ui/row-menu.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
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
      <ul aria-label="Project folders">
        {(roots ?? []).map((root) => (
          <li key={root}>
            <SettingRow
              title={root.split(/[\\/]/).findLast(Boolean) ?? "Projects"}
              description={root}
              compact
              inline
            >
              <RowMenu label={`Actions for ${root}`}>
                <MenuItem
                  disabled={disabled}
                  onClick={() =>
                    void run(() =>
                      saveProjectRoots(
                        client,
                        (roots ?? []).filter((value) => value !== root),
                      ),
                    )
                  }
                >
                  Remove
                </MenuItem>
              </RowMenu>
            </SettingRow>
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
          placeholder="Add a project folder"
          value={path}
          className="min-w-0 flex-1"
          onChange={(event) => setPath(event.target.value)}
          disabled={disabled}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
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
