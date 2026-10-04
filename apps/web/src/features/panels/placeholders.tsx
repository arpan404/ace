import { ChatsCircleIcon, FileTextIcon, FilesIcon } from "@phosphor-icons/react";
import { useId, useMemo } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
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

/**
 * Side chat: a short, temporary conversation about the thread that never touches its work.
 * Running one needs a daemon command for an ephemeral session beside a thread (the protocol has
 * `thread.create`, `thread.send` and `thread.fork`, all of which make lasting threads), so the
 * tab shows the side chat's shape with its composer off and says exactly why.
 */
export function SideChatPlaceholder() {
  const reason = useId();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon icon={ChatsCircleIcon} size={36} empty className="mb-1 text-muted-foreground" />
        <h2 className="text-md font-medium text-foreground">Side chat</h2>
        <p className="max-w-[44ch] text-xs leading-normal text-muted-foreground">
          A side chat asks about this thread without changing its work, and disappears when you
          close it.
        </p>
        <p id={reason} className="mt-2 max-w-[48ch] text-xs leading-normal text-subtle-foreground">
          This daemon can't run one yet: it has no way to start a temporary conversation beside a
          thread, only lasting threads and forks. Ask in the thread's composer, or fork the thread
          to explore without touching it.
        </p>
      </div>
      <div className="shrink-0 px-3 pb-3">
        <div className="mx-auto flex w-full max-w-[736px] flex-col gap-2 rounded-[14px] bg-secondary px-3.5 pt-3 pb-2.5 opacity-70">
          <textarea
            aria-label="Side chat message"
            aria-describedby={reason}
            disabled
            rows={2}
            placeholder="Side chats aren't available on this daemon"
            className="block w-full resize-none bg-transparent text-ui leading-5 text-foreground outline-none placeholder:text-subtle-foreground disabled:cursor-not-allowed"
          />
          <div className="flex h-7 items-center justify-end">
            <Button size="sm" variant="primary" disabled aria-describedby={reason}>
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
