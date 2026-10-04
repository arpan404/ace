import { AppWindowIcon, GitBranchIcon } from "@phosphor-icons/react";
import { displayPath, folderName, parentFolder } from "@ace/ui-core";
import { useEffect, useState } from "react";
import { desktopFolders } from "@/boot/desktop-folders.ts";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { FolderBrowser } from "./folder-browser.tsx";
import { Footer, Offer, Problem } from "./form-parts.tsx";
import { projectFailure, useProjectCommands, type Added } from "./project-commands.ts";
import type { FolderAttempt } from "./requests.ts";
import { useFolderInspection, useHostHome, useRecentFolders } from "./use-folders.ts";

/**
 * Open folder: browse the daemon's folders (or, in the desktop app with a daemon on this
 * computer, use the system's folder picker) and add the selected folder, else the one open.
 * A folder inside a repository offers the repository's root; it's added only if chosen.
 */
export function OpenFolderTab(props: {
  attempt: FolderAttempt | undefined;
  offline: boolean;
  onAdded(result: Added): void;
}) {
  const home = useHostHome().data;
  const recent = useRecentFolders().data?.folders ?? [];
  const commands = useProjectCommands();
  const [path, setPath] = useState<string | undefined>(
    props.attempt ? parentFolder(props.attempt.path) : undefined,
  );
  const [selected, setSelected] = useState<string | undefined>(props.attempt?.path);
  const [problem, setProblem] = useState<{ path: string; message: string } | undefined>(
    props.attempt ? { path: props.attempt.path, message: props.attempt.problem } : undefined,
  );
  const [adding, setAdding] = useState(false);
  const native = useNativePicker();
  const browsing = path ?? home?.path;
  // Nothing selected adds the folder open in the browser, but never a whole root (the home
  // folder): that takes an explicit selection.
  const atRoot = browsing !== undefined && (home?.roots ?? []).includes(browsing);
  const target = selected ?? (atRoot ? undefined : browsing);
  const inspection = useFolderInspection(target).data;
  const root = inspection?.suggestedRepoRoot;

  const add = async (folder: string) => {
    setAdding(true);
    setProblem(undefined);
    try {
      props.onAdded(await commands.add(folder));
    } catch (error) {
      setProblem({ path: folder, message: projectFailure(error).message });
    } finally {
      setAdding(false);
    }
  };
  const reveal = (folder: string) => {
    setPath(parentFolder(folder) ?? folder);
    setSelected(folder);
  };

  return (
    <div className="grid gap-3">
      {native && (
        <div className="flex items-center gap-3">
          <Button
            disabled={props.offline || adding}
            onClick={() =>
              void native.choose().then((chosen) => {
                if (chosen) void add(chosen);
              })
            }
          >
            <Icon icon={AppWindowIcon} size={14} />
            Choose a folder…
          </Button>
          <span className="text-sm text-subtle-foreground">or pick one below</span>
        </div>
      )}
      {recent.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="mr-1 text-sm text-subtle-foreground">Recent</span>
          {recent.map((folder) => (
            <Button
              key={folder.id}
              size="sm"
              variant="ghost"
              title={displayPath(folder.path, home?.path)}
              onClick={() => reveal(folder.path)}
            >
              {folder.name}
            </Button>
          ))}
        </div>
      )}
      <FolderBrowser
        label="Folders"
        path={browsing}
        onPath={setPath}
        selected={selected}
        onSelect={setSelected}
        home={home?.path}
        roots={home?.roots ?? []}
      />
      {problem && problem.path === target ? (
        <Problem>{problem.message}</Problem>
      ) : root && target ? (
        <Offer
          action={
            <Button size="sm" disabled={adding || props.offline} onClick={() => void add(root)}>
              Add {folderName(root)}
            </Button>
          }
        >
          {folderName(target)} is inside the {folderName(root)} repository. Add the repository to
          work on all of it, or add just this folder.
        </Offer>
      ) : null}
      <Footer
        note={
          target && (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {inspection?.git && <Icon icon={GitBranchIcon} size={13} />}
              <span className="truncate">
                {displayPath(target, home?.path)}
                {inspection?.git?.branch ? ` · ${inspection.git.branch}` : ""}
              </span>
            </span>
          )
        }
      >
        <Button
          variant="primary"
          disabled={!target || adding || props.offline}
          onClick={() => target && void add(target)}
        >
          {adding ? "Adding…" : target ? `Add ${folderName(target)}` : "Select a folder"}
        </Button>
      </Footer>
    </div>
  );
}

/** The desktop app's folder picker, when the daemon runs on this computer. */
function useNativePicker() {
  const [picker] = useState(() => desktopFolders());
  const [local, setLocal] = useState(false);
  useEffect(() => {
    if (!picker) return;
    let current = true;
    void picker.local().then((value) => {
      if (current) setLocal(value);
    });
    return () => {
      current = false;
    };
  }, [picker]);
  return picker && local ? picker : undefined;
}
