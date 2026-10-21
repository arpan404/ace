import { displayPath } from "@ace/ui-core";
import { CheckIcon, CopyIcon, FolderOpenIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { useFolderActions } from "@/lib/folder-actions.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { useHostHome } from "./use-folders.ts";

/** Where the project lives, read-only: copy it, or show it in the file manager on desktop. */
export function ProjectPathRow(props: { path: string }) {
  const home = useHostHome(usePrimaryMachine()).data;
  const folder = useFolderActions(props.path);
  const toast = useToast();
  const { copied, copy } = useCopy(() => toast.error({ title: "Couldn't copy the path" }));
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        title={props.path}
        className="min-w-0 flex-1 truncate font-mono text-xs text-subtle-foreground"
      >
        {displayPath(props.path, home?.path)}
      </span>
      <IconButton
        size="sm"
        icon={copied ? CheckIcon : CopyIcon}
        label={copied ? "Copied" : "Copy path"}
        onClick={() => copy(props.path)}
      />
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
