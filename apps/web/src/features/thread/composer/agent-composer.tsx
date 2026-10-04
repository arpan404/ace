import { useClient, useThreadMeta } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { useToast } from "@/components/ui/toast.tsx";
import { Composer, type Draft } from "./composer.tsx";

/**
 * A follow-up to one agent of the tree, in the thread composer's own shell, input and footer.
 * Enter sends it to the agent's own thread (`target`) as a queued message, so it never cuts into
 * a step the agent is taking. Without a thread to reach, the composer is off and points at
 * `unavailable`. The unsent draft is kept per agent, on this device.
 */
export function AgentComposer(props: {
  /** The thread whose agent tree holds the agent. */
  threadId: string;
  agentId: string;
  /** The agent's own thread, when ace can reach it. */
  target: string | undefined;
  label: string;
  placeholder: string;
  unavailable?: { reason: string; describedBy: string; short?: string | undefined } | undefined;
}) {
  const client = useClient();
  const toast = useToast();
  const parent = useThreadMeta(props.threadId);
  const child = useThreadMeta(props.target ?? "");
  const meta = child ?? parent;
  const thread = {
    id: props.target ?? props.threadId,
    workspaceId: meta?.workspaceId ?? "",
    title: meta?.title ?? "",
  };
  const submit = async (draft: Draft) => {
    if (!props.target) return false;
    try {
      await client.enqueue({
        type: "thread.send",
        threadId: ThreadId.parse(props.target),
        input: [{ type: "text", text: draft.text || "See the attached files." }],
        context: { mentions: draft.mentions, attachments: draft.attachments },
        delivery: "queue",
      });
      return true;
    } catch {
      toast.add({
        title: "Couldn't send the follow-up",
        description: "It is still in the composer.",
      });
      return false;
    }
  };
  return (
    <Composer
      thread={thread}
      draftKey={`agent:${props.threadId}:${props.agentId}`}
      keepsAttachments={!!props.target}
      busy={false}
      label={props.label}
      placeholder={props.placeholder}
      unavailable={props.unavailable}
      onSubmit={submit}
    />
  );
}
