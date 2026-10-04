import { ChatsCircleIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";

/*
 * Tools the workspace lists but the daemon can't serve yet. Each says exactly what is missing
 * and offers what does work, instead of looking broken. The Side chat tool replaces
 * this by registering a kind with the same id.
 */

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
        <p id={reason} className="mt-2 max-w-[44ch] text-xs leading-normal text-subtle-foreground">
          This daemon can't run one yet: it has no way to start a temporary conversation beside a
          thread, only lasting threads and forks. Ask in the thread's composer, or fork the thread
          to explore without touching it.
        </p>
      </div>
      <div className="shrink-0 px-3 pb-3">
        <div className="mx-auto flex w-full max-w-[736px] flex-col gap-2 rounded-xl bg-secondary px-3.5 pt-3 pb-2.5 opacity-70">
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
