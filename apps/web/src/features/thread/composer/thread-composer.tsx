import { LaptopIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useClient, useIntent, useInteractions, useThreadMeta } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { RunId, ThreadId } from "@ace/protocol";
import { modelLabel, providerNames, selectionInputs, type AttachmentReader } from "@ace/ui-core";
import { Suspense, useEffect, useId, useRef, useState, type Ref } from "react";
import { useToast } from "@/components/ui/toast.tsx";
// The catalog alone: the models feature is also loaded lazily, so importing its index would bring
// its pickers into this route.
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useToastClearance } from "@/lib/toast-clearance.ts";
import { readingColumn } from "../lib/column.ts";
import type { ThreadRef } from "../sources/index.ts";
import { Composer, type ComposerHandle, type Draft } from "./composer.tsx";
import { useComposerAnswer } from "./answer-slot.ts";
import {
  ControlsPending,
  DeferredCursorContinuation,
  DeferredModelControl,
  DeferredPermissionControl,
  DeferredQueueArea,
} from "./deferred-parts.tsx";
import {
  DeferredEnvironmentStrip,
  DeferredPlanTab,
  DeferredRequestStack,
  DeferredStatusStrip,
  DeferredThreadEnvironment,
} from "./deferred-cards.ts";
import { useShownPlans } from "./plan-state.ts";
import { runsOn, selectionIdentity, type PendingTurn } from "./execution.ts";
import { clearStop, recordStop, useActiveRootRun, useStopping } from "./stop-state.ts";

/** The send pipeline's code: fetched when a composer mounts, so the first Enter never waits on it. */
let sender: Promise<typeof import("./send-message.ts")> | undefined;
const loadSender = () => (sender ??= import("./send-message.ts"));

/** Desktop widths put the caret in the composer when a thread opens; a phone's keyboard waits. */
const wideEnoughToFocus = () =>
  typeof matchMedia === "function" && matchMedia("(min-width: 768px)").matches;

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
 * are approved and the model, both changeable from the next turn. One tab is attached to its top
 * edge, the first of: the agent's open requests (a deck of cards answered there, a picked answer
 * sent with the send button), the agents' to-do list, what the agents are doing with Stop, and
 * where the thread runs. Stop is in the send slot only while the tab doesn't carry it, and never
 * while a request waits. The unsent draft is kept per thread.
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
  const { storage } = useLayout();
  const toast = useToast();
  const meta = useThreadMeta(props.thread.id);
  const [setting] = useDaemonSetting("threads.followUpBehavior", {
    threadId: ThreadId.parse(props.thread.id),
  });
  // Steering needs a provider that says it can take input mid-turn; otherwise (or while its
  // capabilities are unknown) a follow-up queues (SY-14).
  const canSteer = meta?.capabilities?.steer === true;
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
    const { sendMessage } = await loadSender();
    const ok = await sendMessage({
      client,
      storage,
      threadId: props.thread.id,
      commandId,
      draft,
      delivery,
      options: sent?.options,
      notify: (title, description) => toast.add({ title, description }),
    });
    if (ok && sent) setSpent({ commandId, turn: sent });
    return ok;
  };

  useEffect(() => void loadSender(), []);

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
  const plans = useShownPlans(props.thread.id);
  const answer = useComposerAnswer(props.thread.id);
  const tab = asking ? "requests" : plans.length ? "plan" : busy ? "status" : "environment";
  // The environment card, while the person has it open on this thread.
  const [shown, setShown] = useState<string>();
  const environment = shown === props.thread.id;
  const environmentId = useId();
  const toMessage = () => box.current?.querySelector("textarea")?.focus();
  const [focusOnOpen] = useState(wideEnoughToFocus);
  const asked = useRef(false);
  useEffect(() => {
    if (!focusOnOpen || !asking || asked.current) return;
    asked.current = true;
    const root = box.current?.parentElement ?? document.body;
    let cancel: (() => void) | undefined;
    let live = true;
    void import("./focus-on-open.ts").then((module) => {
      if (live) cancel = module.focusOpenRequest(root);
    });
    return () => {
      live = false;
      cancel?.();
    };
  }, [focusOnOpen, asking]);
  // What the thread's provider and model read, for the files attached to the next message.
  const catalog = useModelCatalog();
  const selection = runsOn(meta);
  const reader: AttachmentReader | undefined = meta && {
    provider: providerNames[meta.provider],
    imageInput: meta.capabilities?.imageInput,
    model: selection?.model ? modelLabel(selection.model) : undefined,
    modalities: catalog && selectionInputs(catalog, selection),
  };

  if (meta?.continuation)
    return (
      <Suspense fallback={<p className="px-4 pb-4 text-ui">This Cursor thread is read-only.</p>}>
        <DeferredCursorContinuation.Component thread={meta} />
      </Suspense>
    );

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
          <DeferredQueueArea.Component threadId={props.thread.id} status={props.status} />
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
          onStop={tab === "plan" ? stop : undefined}
          stopping={stopping}
          onReturnedOptions={(options) => {
            const identity = selectionIdentity(runsOn(meta));
            if (options) setPicked({ threadId: props.thread.id, identity, options });
          }}
          autoFocus={focusOnOpen && !asking}
          typeToFocus
          reader={reader}
          sendsWhileUploading
          attached={
            <Suspense fallback={null}>
              {environment ? (
                <DeferredThreadEnvironment.Component
                  thread={props.thread}
                  id={environmentId}
                  onClose={() => {
                    setShown(undefined);
                    toMessage();
                  }}
                />
              ) : tab === "requests" && open ? (
                <DeferredRequestStack.Component
                  threadId={props.thread.id}
                  ids={open}
                  onLeave={toMessage}
                />
              ) : tab === "plan" ? (
                <DeferredPlanTab.Component threadId={props.thread.id} plans={plans} />
              ) : tab === "status" ? (
                <DeferredStatusStrip.Component
                  threadId={props.thread.id}
                  status={props.status}
                  stopping={stopping}
                  onStop={stop}
                />
              ) : (
                <DeferredEnvironmentStrip.Component
                  thread={props.thread}
                  controls={environmentId}
                  onOpen={() => setShown(props.thread.id)}
                />
              )}
            </Suspense>
          }
          answer={tab === "requests" ? answer : undefined}
          controls={
            <Suspense fallback={<ControlsPending />}>
              <DeferredPermissionControl.Component thread={props.thread} />
              {tab !== "environment" && (
                <IconButton
                  icon={LaptopIcon}
                  label="Environment details"
                  aria-expanded={environment}
                  aria-controls={environmentId}
                  onClick={() => setShown(environment ? undefined : props.thread.id)}
                />
              )}
            </Suspense>
          }
          trailing={
            <Suspense fallback={<ControlsPending />}>
              <DeferredModelControl.Component thread={props.thread} busy={busy} next={next} />
            </Suspense>
          }
        />
      </div>
    </div>
  );
}
