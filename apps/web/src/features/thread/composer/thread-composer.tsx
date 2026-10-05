import { useClient, useIntent, useInteractions, useThreadMeta } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { RunId, ThreadId } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { Suspense, useEffect, useRef, useState, type Ref } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useToastClearance } from "@/lib/toast-clearance.ts";
import { readingColumn } from "../lib/column.ts";
import type { ThreadRef } from "../sources/index.ts";
import { Composer, type ComposerHandle, type Draft } from "./composer.tsx";
import { ContextBar } from "./context-bar.tsx";
import { ContextMeter } from "./context-meter.tsx";
import {
  ControlsPending,
  DeferredQueueNotice,
  DeferredQueuedPills,
  DeferredThreadControls,
} from "./deferred-parts.tsx";
import { runsOn, selectionIdentity, type PendingTurn } from "./execution.ts";
import { focusOpenRequest, wideEnoughToFocus } from "./focus-on-open.ts";
import { rememberAttachments } from "./send-store.ts";
import { clearStop, recordStop, useActiveRootRun, useStopping } from "./stop-state.ts";
import { useQueue } from "./use-queue.ts";
import { useQueuedPending } from "./queued-pending.ts";

const composerInset = {
  paddingLeft: "var(--transcript-gutter)",
  paddingRight: "calc(var(--transcript-gutter) + var(--summary-inset, 0px))",
};

/** The agent is mid-turn or held up: a new message follows up rather than starting a turn. */
export function isBusy(status: ThreadStatus | undefined): boolean {
  if (!status) return false;
  if (status.state === "working" || status.state === "needs_you" || status.state === "limited")
    return true;
  return status.state === "waiting" && status.on !== "background_task";
}

/**
 * The thread's composer, on the transcript's column. Enter sends: the message shows as its
 * bubble at once and goes through the client's outbox under its own command id. While the agent
 * works a message follows up the way the daemon's `threads.followUpBehavior` says (queue by
 * default), and ⌘↵ / Ctrl+↵ does the opposite where the provider can steer. Queued messages
 * wait as pills above it, with the reason when the queue is held. Its footer shows how actions
 * are approved and what the thread runs on, both changeable from the next turn. The unsent
 * draft is kept per thread.
 */
export function ThreadComposer({
  composer,
  ...props
}: {
  thread: ThreadRef;
  status: ThreadStatus | undefined;
  composer?: Ref<ComposerHandle> | undefined;
}) {
  const client = useClient();
  const toast = useToast();
  const meta = useThreadMeta(props.thread.id);
  const queue = useQueue(props.thread.id);
  const queuedPending = useQueuedPending(props.thread.id, queue.page);
  const [setting] = useDaemonSetting("threads.followUpBehavior", {
    threadId: ThreadId.parse(props.thread.id),
  });
  // Steering needs a provider that can take input mid-turn; otherwise a follow-up queues.
  const canSteer = meta?.capabilities?.steer !== false;
  const followUp = canSteer ? setting : "queue";
  const busy = isBusy(props.status);
  const threadId = ThreadId.parse(props.thread.id);
  // Toasts (a thread elsewhere needs you, Undo) rise above the composer, never over it.
  const box = useRef<HTMLDivElement>(null);
  useToastClearance(box);
  // Effort and speed picked for the next message: this thread's, for the selection they were
  // picked for. The controls re-check them when the thread moves to another model.
  const [picked, setPicked] = useState<PendingTurn & { threadId: string }>();
  // The message that carried them: they're spent once the daemon accepts it, not before, so
  // a refused message leaves them picked.
  const [spent, setSpent] = useState<{ commandId: string; turn: PendingTurn }>();
  const accepted = useIntent(spent?.commandId)?.state === "acked";
  const pending =
    picked?.threadId === props.thread.id && !(accepted && spent?.turn === picked)
      ? picked
      : undefined;
  const next = {
    pending,
    onChange: (turn: PendingTurn | undefined) =>
      setPicked(turn && { threadId: props.thread.id, ...turn }),
  };

  const submit = async (draft: Draft) => {
    // Never send options picked for another selection; the controls are re-checking them.
    const sent = pending?.identity === selectionIdentity(runsOn(meta)) ? pending : undefined;
    const commandId = crypto.randomUUID();
    // While the agent works the delivery is said outright, so this window knows at once
    // whether the message is a bubble (steered in) or a pill (queued).
    const other = followUp === "steer" ? "queue" : "steer";
    const delivery = busy ? (draft.opposite ? other : (followUp ?? "queue")) : undefined;
    rememberAttachments(draft.local);
    try {
      await client.enqueue(
        {
          type: "thread.send",
          threadId,
          input: [{ type: "text", text: draft.text || "See the attached files." }],
          context: { mentions: draft.mentions, attachments: draft.attachments },
          ...(delivery ? { delivery } : {}),
          ...(sent ? { options: sent.options } : {}),
        },
        commandId,
      );
      if (sent) setSpent({ commandId, turn: sent });
      return true;
    } catch {
      toast.add({
        title: "Couldn't send the message",
        description: "This device couldn't save it. It is back in the composer.",
      });
      return false;
    }
  };

  // Stop names the turn it was pressed in, and reads "Stopping…" until that turn ends.
  const run = useActiveRootRun(props.thread.id);
  const stopping = useStopping(props.thread.id);
  const stop = () => {
    const commandId = crypto.randomUUID();
    recordStop(props.thread.id, { commandId, runId: run });
    void client
      .enqueue(
        {
          type: "thread.interrupt",
          threadId,
          cascade: true,
          ...(run ? { runId: RunId.parse(run) } : {}),
        },
        commandId,
      )
      .catch(() => {
        clearStop(props.thread.id);
        toast.add({ title: "Couldn't stop the agent" });
      });
  };
  useEffect(() => {
    if (!busy) clearStop(props.thread.id);
  }, [busy, props.thread.id]);

  // Opening a thread on a desktop puts the caret in the message, unless the agent is asking
  // something: then its first option takes focus (UX audit CMP-2).
  const open = useInteractions(props.thread.id);
  const asking = !!open?.length;
  const [focusOnOpen] = useState(wideEnoughToFocus);
  const asked = useRef(false);
  useEffect(() => {
    if (!focusOnOpen || !asking || asked.current) return;
    asked.current = true;
    return focusOpenRequest(box.current?.parentElement ?? document.body);
  }, [focusOnOpen, asking]);
  const readsImages = meta?.capabilities?.imageInput;

  return (
    // A pinned summary beside the text insets the composer with it (`--summary-inset`), so their
    // edges still agree. The backdrop runs from 2.5rem above the composer to the bottom edge and fades in over
    // its first 2.5rem, so transcript text dissolves under it with no band edge.
    <div
      ref={box}
      style={composerInset}
      className="relative flex-none pb-4 before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:bottom-0 before:bg-reading before:[mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)]"
    >
      <div className={`relative ${readingColumn}`}>
        <Suspense fallback={null}>
          <DeferredQueueNotice.Component
            threadId={props.thread.id}
            status={props.status}
            queue={queue}
          />
          {(!!queue.page?.messages.length || queuedPending.length > 0) && (
            <DeferredQueuedPills.Component queue={queue} pending={queuedPending} />
          )}
        </Suspense>
        <Composer
          ref={composer}
          thread={props.thread}
          draftKey={`thread:${props.thread.id}`}
          keepsAttachments
          busy={busy}
          followUp={followUp}
          canSteer={canSteer}
          onSubmit={submit}
          onStop={stop}
          stopping={stopping}
          onReturnedOptions={(options) => {
            const identity = selectionIdentity(runsOn(meta));
            if (options) setPicked({ threadId: props.thread.id, identity, options });
          }}
          autoFocus={focusOnOpen && !asking}
          typeToFocus
          imagesUnavailable={
            readsImages === false && meta
              ? `${providerNames[meta.provider]} doesn't read images`
              : undefined
          }
          controls={
            <Suspense fallback={<ControlsPending />}>
              <DeferredThreadControls.Component thread={props.thread} busy={busy} next={next} />
            </Suspense>
          }
          status={<ContextMeter threadId={props.thread.id} />}
        />
        <ContextBar thread={props.thread} />
      </div>
    </div>
  );
}
