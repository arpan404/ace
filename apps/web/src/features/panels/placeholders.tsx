import { ChatsCircleIcon, FileTextIcon, FilesIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { useTurns } from "./changes/use-turns.ts";
import { fileSuggestions } from "./launcher/suggestions.ts";

/*
 * Tools the workspace lists but the daemon can't serve yet. Each says exactly what is missing
 * and offers what does work, instead of looking broken. The Files and Side chat tools replace
 * these by registering kinds with the same ids.
 */

/**
 * Files: browsing the checkout needs a directory listing (`files.request` has stat and download
 * but no `list` op). The files this thread's agents edited open in Changes meanwhile.
 */
export function FilesPlaceholder(props: TabViewProps) {
  const actions = useWorkspaceActions(props.scope);
  const turns = useTurns(props.scope);
  const files = useMemo(() => fileSuggestions(turns, 8), [turns]);
  return (
    <div className="flex h-full flex-col">
      <EmptyState
        icon={FilesIcon}
        title="Browsing the checkout isn't available yet"
        description="This daemon can read a file it is pointed at but can't list folders, so there is no tree to browse. Files the agents edited open in Changes."
        className="h-auto flex-none pt-16 pb-6"
      />
      {files.length > 0 && (
        <ul
          aria-label="Edited files"
          className="mx-auto flex w-full max-w-[480px] flex-col gap-0.5 px-6"
        >
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => actions.open({ kind: "changes", data: { path: file.path } })}
                className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 text-left text-ui outline-none hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)]"
              >
                <FileTextIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
                <span className="shrink-0 truncate font-mono text-[12.5px]">{file.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
                  {file.folder || "Project root"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Side chat: a temporary conversation beside the thread needs a daemon API for one. */
export function SideChatPlaceholder() {
  return (
    <EmptyState
      icon={ChatsCircleIcon}
      title="Side chats aren't available yet"
      description="A side chat is a short, temporary conversation about this thread that never changes its work. The daemon has no way to run one yet; ask in the thread's composer meanwhile."
    />
  );
}
