import { useClient, useThreadMeta } from "@ace/client-react";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import { Suspense, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { Composer, type Draft } from "./composer.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/** Says so when the daemon refuses a follow-up; loads with the first one sent. */
const DeferredAgentSendWatch = deferredComponent(() =>
  import("./agent-send-watch.tsx").then((module) => module.AgentSendWatch),
);

type Send = Extract<CommandPayload, { type: "thread.send" }>;

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
  const draftKey = `agent:${props.threadId}:${props.agentId}`;
  // The last follow-up sent: if the daemon refuses it, say why and offer it back (SY-3).
  const [sent, setSent] = useState<{ id: string; payload: Send }>();
  const submit = async (draft: Draft) => {
    if (!props.target) return false;
    const payload: Send = {
      type: "thread.send",
      threadId: ThreadId.parse(props.target),
      input: [{ type: "text", text: draft.text || "See the attached files." }],
      context: { mentions: draft.mentions, attachments: draft.attachments },
      delivery: "queue",
    };
    try {
      const id = crypto.randomUUID();
      setSent({ id, payload });
      await client.enqueue(payload, id);
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
    <>
      {sent && (
        <Suspense fallback={null}>
          <DeferredAgentSendWatch.Component
            commandId={sent.id}
            payload={sent.payload}
            draftKey={draftKey}
          />
        </Suspense>
      )}
      <Composer
        thread={thread}
        draftKey={draftKey}
        keepsAttachments={!!props.target}
        busy={false}
        label={props.label}
        placeholder={props.placeholder}
        unavailable={props.unavailable}
        onSubmit={submit}
      />
    </>
  );
}
