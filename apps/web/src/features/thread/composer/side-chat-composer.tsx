import { useThreadMeta } from "@ace/client-react";
import { Composer } from "./composer.tsx";

const never = async () => false;

/**
 * A side chat's composer: the thread composer's own shell, input and footer, off while the
 * daemon can't run side chats, its reason attached to the input and the send button.
 */
export function SideChatComposer(props: {
  threadId: string;
  reason: string;
  reasonId: string;
  /** The reason in a few words, for the placeholder. */
  short?: string | undefined;
}) {
  const meta = useThreadMeta(props.threadId);
  const thread = {
    id: props.threadId,
    workspaceId: meta?.workspaceId ?? "",
    title: meta?.title ?? "",
  };
  return (
    <Composer
      thread={thread}
      busy={false}
      label="Side chat message"
      placeholder="Ask about this thread"
      unavailable={{ reason: props.reason, describedBy: props.reasonId, short: props.short }}
      onSubmit={never}
    />
  );
}
