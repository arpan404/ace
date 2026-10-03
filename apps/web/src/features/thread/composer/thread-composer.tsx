import { useClient } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { defaultModelChoice, type ModelChoice } from "@ace/ui-core";
import { useModelChoices } from "@/features/models/index.ts";
import { Composer, type Draft } from "./composer.tsx";
import { ContextBar } from "./context-bar.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { QueuedPills, useQueue } from "./queued.tsx";

/** The agent is mid-turn or held up: a new message waits unless the person steers. */
export function isBusy(status: ThreadStatus | undefined): boolean {
  if (!status) return false;
  if (status.state === "working" || status.state === "needs_you") return true;
  return status.state === "waiting" && status.on !== "background_task";
}

/**
 * The thread's composer. Enter sends, or queues while the agent works; ⌘↵ steers the running
 * turn; Stop interrupts the agent and its subagents. Every one is a durable intent, and what it
 * did arrives through the thread's live store.
 */
export function ThreadComposer(props: {
  thread: ThreadRef;
  status: ThreadStatus | undefined;
  provider: ModelChoice["provider"] | undefined;
}) {
  const client = useClient();
  const sources = useThreadSources();
  const toast = useToast();
  const queue = useQueue(props.thread.id);
  const choices = useModelChoices();
  const [model, setModel] = useState<ModelChoice>();
  const busy = isBusy(props.status);
  const threadId = ThreadId.parse(props.thread.id);

  const submit = async (draft: Draft) => {
    try {
      const intentId = await client.enqueue({
        type: "thread.send",
        threadId,
        input: [{ type: "text", text: draft.text || "See the attached files." }],
        context: { mentions: draft.mentions, attachments: draft.attachments },
        delivery: draft.steer ? "steer" : "queue",
      });
      if (busy && !draft.steer) queue.add({ intentId, text: draft.text });
      return true;
    } catch {
      toast.add({ title: "Couldn't send the message", description: "It is back in the composer." });
      return false;
    }
  };
  const stop = () =>
    void client
      .enqueue({ type: "thread.interrupt", threadId, cascade: true })
      .catch(() => toast.add({ title: "Couldn't stop the agent" }));

  return (
    // The backdrop runs from 2.5rem above the composer to the bottom edge and fades in over
    // its first 2.5rem, so transcript text dissolves under it with no band edge.
    <div className="relative flex-none px-8 pb-3.5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:bottom-0 before:bg-reading before:[mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)]">
      <div className="relative mx-auto max-w-(--column)">
        <QueuedPills
          queued={queue.queued}
          onRemove={(message) => {
            queue.remove(message.intentId);
            void sources.actions.unqueue(props.thread, message.intentId);
          }}
        />
        <Composer
          thread={props.thread}
          busy={busy}
          onSubmit={submit}
          onStop={stop}
          controls={
            <ModelPicker
              choices={choices}
              value={model ?? defaultModelChoice(choices, props.provider)}
              onChange={setModel}
            />
          }
        />
        <ContextBar thread={props.thread} />
      </div>
    </div>
  );
}
