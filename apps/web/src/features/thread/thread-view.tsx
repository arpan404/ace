import { useThreadError, useThreadMeta } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import { useMemo, useState } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/skeleton.tsx";
import { threadPanels } from "@/features/panels/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { ThreadComposer } from "./composer/thread-composer.tsx";
import { GitButton, OpenButton, RunButton } from "./header/header-actions.tsx";
import { RenameDialog, ThreadMenuItems } from "./header/thread-menu.tsx";
import type { ThreadRef } from "./sources/index.ts";
import { ForkDialog, ForkOpener } from "./transitions/fork-dialog.tsx";
import { Transcript } from "./transcript/transcript.tsx";
import { useProjectName } from "@/lib/projects.ts";

/**
 * A thread: the transcript and composer in the main column, Run · Open · Commit in the header,
 * Changes · Preview · Agents on the right and Terminal · Logs below.
 */
export function ThreadView(props: { threadId: string }) {
  const meta = useThreadMeta(props.threadId);
  const error = useThreadError(props.threadId);
  const [renaming, setRenaming] = useState(false);
  const [forking, setForking] = useState<ForkPoint>();
  const id = props.threadId;
  const projectName = useProjectName();
  const title = meta?.title;
  const thread = useMemo<ThreadRef | undefined>(
    () => (meta && title !== undefined ? { id, workspaceId: meta.workspaceId, title } : undefined),
    [id, meta, title],
  );
  return (
    <Screen
      title={title ?? "Loading thread…"}
      subtitle={meta && projectName(meta.workspaceId)}
      menu={
        thread && (
          <ThreadMenuItems thread={thread} onRename={() => setRenaming(true)} onFork={setForking} />
        )
      }
      actions={
        thread && (
          <>
            <RunButton thread={thread} />
            <OpenButton thread={thread} />
            <GitButton thread={thread} />
          </>
        )
      }
      {...threadPanels(id)}
    >
      {error ? (
        <div role="alert" className="h-full">
          <EmptyState
            icon={WarningCircleIcon}
            title="This thread couldn't be loaded"
            description={`The daemon said: ${error.message}. The agents keep working; try again from the list.`}
            action={
              <Link to="/" className={buttonVariants({ size: "sm" })}>
                Back to Home
              </Link>
            }
          />
        </div>
      ) : !meta ? (
        <TranscriptSkeleton />
      ) : (
        <ForkOpener value={setForking}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <Transcript threadId={id} />
            </div>
            {thread && <ThreadComposer thread={thread} status={meta?.status} />}
          </div>
        </ForkOpener>
      )}
      {renaming && thread && <RenameDialog thread={thread} onClose={() => setRenaming(false)} />}
      {forking && thread && (
        <ForkDialog thread={thread} point={forking} onClose={() => setForking(undefined)} />
      )}
    </Screen>
  );
}

/** The shape of a transcript while its first window arrives: an ask, a work line, an answer. */
function TranscriptSkeleton() {
  return (
    <LoadingRegion
      label="thread"
      className="mx-auto flex w-full max-w-(--column) flex-col px-8 pt-16"
    >
      <Skeleton className="ml-auto h-14 w-3/5 rounded-[16px_16px_4px_16px]" />
      <Skeleton className="mt-10 h-3 w-48" />
      <SkeletonText lines={4} className="mt-6" />
    </LoadingRegion>
  );
}
