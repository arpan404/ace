import { displayPath } from "@ace/ui-core";
import { CopyIcon, FolderOpenIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useFolderActions } from "@/lib/folder-actions.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { useHostHome } from "./use-folders.ts";

/** Where the project lives, read-only: copy it, or show it in the file manager on desktop. */
export function ProjectPathRow(props: { path: string }) {
  const home = useHostHome(usePrimaryMachine()).data;
  const folder = useFolderActions(props.path);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        title={props.path}
        className="min-w-0 flex-1 truncate font-mono text-xs text-subtle-foreground"
      >
        {displayPath(props.path, home?.path)}
      </span>
      <IconButton size="sm" icon={CopyIcon} label="Copy path" onClick={folder.copy} />
      {folder.reveal && (
        <IconButton
          size="sm"
          icon={FolderOpenIcon}
          label={folder.revealLabel}
          onClick={folder.reveal}
        />
      )}
    </div>
  );
}
