import { ChatsCircleIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { Icon } from "@/components/icon.tsx";
import type { TabViewProps } from "@/lib/workspace/index.ts";
import { useThreadParts } from "./agents/thread-parts.ts";

/*
 * Tools the workspace lists but the daemon can't serve yet. Each says exactly what is missing
 * and offers what does work, instead of looking broken. The Side chat tool replaces
 * this by registering a kind with the same id.
 */

/** The one line a side chat shows while the daemon can't run one. */
export const sideChatUnavailable =
  "This daemon can't start side chats yet. Fork the thread to explore without changing it.";

/**
 * Side chat: a short, temporary conversation about the thread that never touches its work.
 * Running one needs a daemon command for an ephemeral session scoped to a thread (the protocol
 * has `thread.create`, `thread.send` and `thread.fork`, all of which make lasting threads), so
 * the tab shows the side chat's shape, with the thread composer's own geometry switched off and
 * the reason attached.
 */
export function SideChatPlaceholder(props: TabViewProps) {
  const reason = useId();
  const { SideChatComposer } = useThreadParts();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon icon={ChatsCircleIcon} size={36} empty className="mb-1 text-muted-foreground" />
        <h2 className="text-md font-medium text-foreground">Side chat</h2>
        <p className="max-w-[44ch] text-xs leading-normal text-muted-foreground">
          A side chat asks about this thread without changing its work, and disappears when you
          close it.
        </p>
        <p id={reason} className="mt-2 max-w-[44ch] text-xs leading-normal text-subtle-foreground">
          {sideChatUnavailable}
        </p>
      </div>
      {SideChatComposer && (
        <div className="shrink-0 px-4 pb-4">
          <div className="mx-auto w-full max-w-[736px]">
            <SideChatComposer
              threadId={props.scope}
              reason={sideChatUnavailable}
              reasonId={reason}
            />
          </div>
        </div>
      )}
    </div>
  );
}
