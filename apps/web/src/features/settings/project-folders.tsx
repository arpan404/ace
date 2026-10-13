import { FolderPlusIcon } from "@phosphor-icons/react";
import { useClient, useConnectionState } from "@ace/client-react";
import { folderName, projectProblem } from "@ace/ui-core";
import { Icon } from "@/components/icon.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  SettingFooter,
  SettingList,
  SettingNote,
  SettingRow,
  SettingSection,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { RowMenu } from "@/components/ui/row-menu.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import {
  ProjectRootRefused,
  addProjectRoot,
  createProjectRoot,
  resolveRootPath,
  saveProjectRoots,
} from "@/lib/project-roots.ts";

/**
 * The folders the daemon may open projects in. A typed folder that doesn't exist yet is
 * offered for creating, on the daemon's machine; Enter again (or the offer) creates and adds it.
 */
export function ProjectFolders() {
  const client = useClient();
  const [roots] = useDaemonSetting("projects.roots");
  const offline = useConnectionState() !== "ready";
  const query = useQueryClient();
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  /** The folder typed, resolved, when the daemon said it doesn't exist. */
  const [missing, setMissing] = useState<{ typed: string; path: string }>();
  /** `write` says whether it saved; one that didn't keeps what was typed. */
  const run = async (write: () => Promise<boolean>) => {
    setPending(true);
    setProblem(undefined);
    try {
      if (!(await write())) return;
      setPath("");
      setMissing(undefined);
      await query.invalidateQueries({ queryKey: ["projects", "folders"] });
    } catch (error) {
      setProblem(
        error instanceof ProjectRootRefused
          ? projectProblem(error.code).message
          : "Couldn't save this folder. Use its full path and try again.",
      );
    } finally {
      setPending(false);
    }
  };
  const typed = path.trim();
  const offer = missing?.typed === typed ? missing : undefined;
  const add = () =>
    void run(async () => {
      if (offer) {
        await createProjectRoot(client, offer.path);
        return true;
      }
      const resolved = await resolveRootPath(client, typed);
      try {
        await addProjectRoot(client, resolved);
        return true;
      } catch (error) {
        if (!(error instanceof ProjectRootRefused && error.code === "directory_missing"))
          throw error;
        setMissing({ typed, path: resolved });
        return false;
      }
    });
  const disabled = offline || pending || roots === undefined;
  return (
    <SettingSection label="Project folders" anchor="projects.roots" scope="daemon">
      {roots?.length ? (
        <SettingList aria-label="Project folders">
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
                      void run(async () => {
                        await saveProjectRoots(
                          client,
                          (roots ?? []).filter((value) => value !== root),
                        );
                        return true;
                      })
                    }
                  >
                    Remove
                  </MenuItem>
                </RowMenu>
              </SettingRow>
            </li>
          ))}
        </SettingList>
      ) : null}
      <SettingFooter className="justify-start">
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
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
            disabled={disabled || !/^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(typed)}
          >
            {offer ? "Create and add" : "Add folder"}
          </Button>
        </form>
        {offer && (
          <button
            type="button"
            aria-label={`Create ${folderName(offer.path)} and add`}
            disabled={disabled}
            onClick={add}
            className="flex h-[30px] min-w-0 basis-full items-center gap-2 rounded-sm bg-accent px-2 text-left text-ui text-foreground focus-ring disabled:opacity-60"
          >
            <Icon icon={FolderPlusIcon} size={14} className="shrink-0 text-primary" />
            <span className="shrink-0">
              Create <b className="font-semibold">{folderName(offer.path)}</b> and add
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-subtle-foreground">
              {offer.path}
            </span>
          </button>
        )}
      </SettingFooter>
      {problem && (
        <SettingNote role="alert" className="text-status-failed">
          {problem}
        </SettingNote>
      )}
    </SettingSection>
  );
}
