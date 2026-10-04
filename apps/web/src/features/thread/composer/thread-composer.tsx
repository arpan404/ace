import { useClient, useThreadMeta } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { Suspense, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useToastClearance } from "@/lib/toast-clearance.ts";
import { readingColumn } from "../lib/column.ts";
import type { ThreadRef } from "../sources/index.ts";
import { Composer, type Draft } from "./composer.tsx";
import { ContextBar } from "./context-bar.tsx";
import { ContextMeter } from "./context-meter.tsx";
import {
  ControlsPending,
  DeferredQueueNotice,
  DeferredQueuedPills,
  DeferredThreadControls,
} from "./deferred-parts.tsx";
import { useQueue } from "./use-queue.ts";

/** The agent is mid-turn or held up: a new message follows up rather than starting a turn. */
export function isBusy(status: ThreadStatus | undefined): boolean {
  if (!status) return false;
  if (status.state === "working" || status.state === "needs_you" || status.state === "limited")
    return true;
  return status.state === "waiting" && status.on !== "background_task";
}

/**
 * The thread's composer, on the transcript's column. Enter sends; while the agent works a
 * message follows up the way the daemon's `threads.followUpBehavior` says (queue by default), and
 * ⌘↵ / Ctrl+↵ does the opposite. Queued messages wait on the daemon's queue above it, with the
 * reason when the queue is held. Its footer shows how actions are approved and what the thread
 * runs on, both changeable from the next turn. The unsent draft is kept per thread.
 */
export function ThreadComposer(props: { thread: ThreadRef; status: ThreadStatus | undefined }) {
  const client = useClient();
  const toast = useToast();
  const meta = useThreadMeta(props.thread.id);
  const queue = useQueue(props.thread.id);
  const [followUp] = useDaemonSetting("threads.followUpBehavior", {
    threadId: ThreadId.parse(props.thread.id),
  });
  const busy = isBusy(props.status);
  const threadId = ThreadId.parse(props.thread.id);
  // Toasts (a thread elsewhere needs you, Undo) rise above the composer, never over it.
  const box = useRef<HTMLDivElement>(null);
  useToastClearance(box);

  const submit = async (draft: Draft) => {
    try {
      await client.enqueue({
        type: "thread.send",
        threadId,
        input: [{ type: "text", text: draft.text || "See the attached files." }],
        context: { mentions: draft.mentions, attachments: draft.attachments },
        // Plain Enter leaves delivery to the daemon's setting; ⌘↵ overrides it.
        ...(draft.opposite ? { delivery: followUp === "steer" ? "queue" : "steer" } : {}),
      });
      return true;
    } catch {
      toast.add({
        title: "Couldn't send the message",
        description: "It is still in the composer.",
      });
      return false;
    }
  };
  const stop = () =>
    void client
      .enqueue({ type: "thread.interrupt", threadId, cascade: true })
      .catch(() => toast.add({ title: "Couldn't stop the agent" }));
  const readsImages = meta?.capabilities?.imageInput;

  return (
    // The backdrop runs from 2.5rem above the composer to the bottom edge and fades in over
    // its first 2.5rem, so transcript text dissolves under it with no band edge.
    <div
      ref={box}
      className="relative flex-none px-(--transcript-gutter) pb-4 before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:bottom-0 before:bg-reading before:[mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)]"
    >
      <div className={`relative ${readingColumn}`}>
        <Suspense fallback={null}>
          <DeferredQueueNotice.Component
            threadId={props.thread.id}
            status={props.status}
            queue={queue}
          />
          {!!queue.page?.messages.length && <DeferredQueuedPills.Component queue={queue} />}
        </Suspense>
        <Composer
          thread={props.thread}
          draftKey={`thread:${props.thread.id}`}
          keepsAttachments
          busy={busy}
          followUp={followUp}
          onSubmit={submit}
          onStop={stop}
          imagesUnavailable={
            readsImages === false && meta
              ? `${providerNames[meta.provider]} doesn't read images`
              : undefined
          }
          controls={
            <Suspense fallback={<ControlsPending />}>
              <DeferredThreadControls.Component thread={props.thread} busy={busy} />
            </Suspense>
          }
          status={<ContextMeter threadId={props.thread.id} />}
        />
        <ContextBar thread={props.thread} />
      </div>
    </div>
  );
}
