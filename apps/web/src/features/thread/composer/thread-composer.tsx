import {
  useClient,
  useIntent,
  useInteractions,
  useThreadMeta,
  useThreadStore,
} from "@ace/client-react";
import { useComposerActions } from "./composer-actions.ts";
import type { ThreadStatus } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import {
  modelLabel,
  providerNames,
  followUpDelivery,
  isBusy,
  waitingDelivery,
  selectionInputs,
  choiceSelection,
  currentModelChoice,
  followUpTurnOptions,
  parseGoalCommand,
  runningSubagents,
  type AttachmentReader,
} from "@ace/ui-core";
import { Suspense, useContext, useEffect, useRef, useState, type Ref } from "react";
import { TimeContext } from "@/lib/time.ts";
import { uploadClock } from "@/features/thread/composer/upload-interruption.ts";
import { useToast } from "@/components/ui/toast.tsx";
// The catalog alone: the models feature is also loaded lazily, so importing its index would bring
// its pickers into this route.
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useModelChoices } from "@/features/models/index.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { ThreadRef } from "../sources/index.ts";
import { Composer, type ComposerHandle, type Draft } from "./composer.tsx";
import { useThreadLiveState } from "../lib/live-state.ts";
import { ComposerDock } from "./composer-dock.tsx";
import {
  ControlsPending,
  DeferredCursorContinuation,
  DeferredModelControl,
  DeferredPermissionControl,
} from "./deferred-parts.tsx";
import { DeferredComposerStrip } from "./deferred-cards.ts";
import { useTurnActivity } from "../transcript/use-turn-activity.ts";
import { finishQueueEdit, queueEditSession, saveQueueEdit } from "./queue-edit.ts";
import { sentText } from "./last-sent.ts";
import { runsOn, selectionIdentity, type PendingTurn } from "./execution.ts";
import { clearStop, recordStop, useStopFence, useStopping } from "./stop-state.ts";
import { useNavigate } from "@tanstack/react-router";
import { failureMessage } from "@/lib/daemon-command.ts";
import { useGoalCommand } from "./goal-command.ts";
import { useQuestionReply } from "./use-question-reply.ts";
import { useThreadSources } from "../sources/index.ts";
import {
  ContinuationRefused,
  continueInNewThread,
  TurnStillRunning,
  type Continuation,
} from "./continue-in-thread.ts";

/** The send pipeline's code: fetched when a composer mounts, so the first Enter never waits on it. */
let sender: Promise<typeof import("./send-message.ts")> | undefined;
const loadSender = () => (sender ??= import("./send-message.ts"));

/** Desktop widths put the caret in the composer when a thread opens; a phone's keyboard waits. */
const wideEnoughToFocus = () =>
  typeof matchMedia === "function" && matchMedia("(min-width: 768px)").matches;

/** How soon after the first Esc a second one stops the agent tree. */
export const stopKeyWindowMs = 1_500;

/**
 * The thread's composer, on the transcript's column. Enter sends: the message shows as its
 * bubble at once and goes through the client's outbox under its own command id. While the agent
 * works a message follows up the way the daemon's `threads.followUpBehavior` says (queue by
 * default), and ⌘↵ / Ctrl+↵ does the opposite where the provider can steer. Its footer shows
 * how actions are approved and the model, both changeable from the next turn. Nothing sits below
 * it; one strip sits above it (`ComposerStrip`): the agent's open requests (answered on their
 * card there), the connection, the queue or the plan. Stop occupies the primary slot while the agent
 * works and the draft is empty, and never while a question waits. ↑ in an empty composer brings back
 * the last message sent. The unsent draft is kept per thread.
 */
export function ThreadComposer({
  composer,
  ...props
}: {
  thread: ThreadRef;
  status: ThreadStatus | undefined;
  composer?: Ref<ComposerHandle> | undefined;
  requestTarget?: string | undefined;
}) {
  const client = useClient();
  const { storage } = useLayout();
  const time = useContext(TimeContext);
  const toast = useToast();
  const meta = useThreadMeta(props.thread.id);
  const changeGoal = useGoalCommand(props.thread.id);
  const question = useQuestionReply(props.thread.id);
  // Read when ↑ asks, never subscribed: the transcript changing doesn't re-render the composer.
  const transcript = useThreadStore(props.thread.id);
  const modelChoices = useModelChoices();
  const [setting] = useDaemonSetting("threads.followUpBehavior", {
    threadId: ThreadId.parse(props.thread.id),
  });
  // Steering needs a provider that says it can take input mid-turn; otherwise (or while its
  // capabilities are unknown) a follow-up queues (SY-14).
  const canSteer = meta?.capabilities?.steer === true;
  const followUp = canSteer ? setting : "queue";
  const busy = isBusy(props.status);
  // The root only waits on its subagents: the model itself isn't busy, so a message goes in now.
  const wait = useTurnActivity(props.thread.id)?.waitingOn;
  const subagentWait = wait?.kind === "subagents" ? wait : undefined;
  const waitDelivery = (opposite: boolean) =>
    subagentWait && waitingDelivery({ canSteer, turnOver: subagentWait.turnOver, opposite });
  const sendsNow = waitDelivery(false) === "steer";
  const [pickerRequest, requestPicker] = useState(0);
  const [tuneRequest, requestTune] = useState(0);
  const activityState = useThreadLiveState(props.thread.id);
  const threadId = ThreadId.parse(props.thread.id);
  // Toasts (a thread elsewhere needs you, Undo) rise above the composer, never over it.
  const box = useRef<HTMLDivElement>(null);
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

  const sent = pending?.identity === selectionIdentity(runsOn(meta)) ? pending : undefined;

  // A model this thread continues on in a new thread: the next message starts it there.
  const sources = useThreadSources();
  const navigate = useNavigate();
  const [continuation, setContinuation] = useState<Continuation>();
  const continuing = continuation?.threadId === props.thread.id ? continuation : undefined;
  const continued = {
    choice: continuing?.choice,
    onChange: (choice: Continuation["choice"] | undefined) =>
      setContinuation(choice && { threadId: props.thread.id, choice }),
  };
  const continueThread = async (draft: Draft, target: Continuation) => {
    try {
      const opened = await continueInNewThread({
        client,
        actions: sources.actions,
        thread: props.thread,
        choice: target.choice,
        modalities: catalog && selectionInputs(catalog, choiceSelection(target.choice)),
        draft,
      });
      setContinuation(undefined);
      void navigate({ to: "/t/$threadId", params: { threadId: opened } });
      return true;
    } catch (error) {
      toast.error({
        title: "Message not sent",
        description: error instanceof ContinuationRefused ? error.message : failureMessage(error),
        // The person picked another model to get past this turn: one click stops it.
        ...(error instanceof TurnStillRunning
          ? { actionProps: { children: "Stop agent", onClick: () => stop() } }
          : {}),
      });
      return false;
    }
  };

  const submit = async (draft: Draft) => {
    if (continuing) return continueThread(draft, continuing);
    if (queueEditSession(props.thread.id)) return saveEdit(draft);
    // `/goal …` sets, pauses or clears the provider's own goal where ace drives it natively;
    // with files or mentions it is a message like any other.
    const goal =
      meta?.capabilities?.goals && !draft.files.local.length && !draft.mentions.length
        ? parseGoalCommand(draft.text)
        : undefined;
    if (goal) {
      const changed = await changeGoal(goal);
      if (changed) draft.files.release();
      return changed;
    }
    // Plain words, while the agent waits on its question, answer it.
    if (await question.reply(draft)) return true;
    // Never send options picked for another selection; the controls are re-checking them.
    const commandId = crypto.randomUUID();
    // While the agent works the delivery is said outright, so this window knows at once
    // whether the message is a bubble (steered in) or a pill (queued).
    // A steer always steers: a new model or effort on it takes effect from the next turn.
    const delivery =
      waitDelivery(draft.opposite) ??
      followUpDelivery({
        status: props.status,
        canSteer,
        setting,
        opposite: draft.opposite,
      });
    // What a follow-up without options inherits: a switch waiting for the next turn, else what
    // runs now. Steering leaves the running turn intact.
    const options = followUpTurnOptions({
      thread: meta,
      choice: currentModelChoice(modelChoices, runsOn(meta)),
      pending,
      busy,
      delivery,
    });
    const { sendMessage } = await loadSender();
    const ok = await sendMessage({
      client,
      storage,
      clock: uploadClock(time.read),
      threadId: props.thread.id,
      commandId,
      draft,
      delivery,
      options,
      notify: (title, description) => toast.error({ title, description }),
    });
    if (ok && sent) setSpent({ commandId, turn: sent });
    return ok;
  };

  /**
   * Enter while a queued message is open in the composer saves its new words to the queue, then
   * brings back what the person had been writing. Only words change: its files stay as they were.
   */
  const saveEdit = async (draft: Draft) => {
    const editing = props.thread.id;
    const outcome = await saveQueueEdit(editing, draft.text);
    if (outcome === "saved") {
      draft.files.release();
      finishQueueEdit(editing);
      return true;
    }
    if (outcome === "gone") {
      toast.add({
        title: "That message already left the queue",
        description: "Your edit is back in the composer.",
      });
      // After the composer has its edited words back.
      setTimeout(() => finishQueueEdit(editing), 0);
    }
    return false;
  };

  useEffect(() => void loadSender(), []);

  // Stop names the turn it was pressed in, and reads "Stopping…" until that turn ends.
  const fence = useStopFence(props.thread.id);
  const run = fence && "runId" in fence ? fence.runId : undefined;
  const stopping = useStopping(props.thread.id);
  const stop = () => {
    if (!fence) return;
    const commandId = crypto.randomUUID();
    recordStop(props.thread.id, { commandId, runId: run });
    void client
      .enqueue(
        {
          type: "thread.interrupt",
          threadId,
          cascade: true,
          ...fence,
        },
        commandId,
      )
      .catch(() => {
        clearStop(props.thread.id);
        toast.error({ title: "Couldn't stop the agent" });
      });
  };
  useEffect(() => {
    if (!busy) clearStop(props.thread.id);
  }, [busy, props.thread.id]);
  // Opening a thread on a desktop puts the caret in the message, unless the agent is asking
  // something: then its first option takes focus (UX audit CMP-2).
  const open = useInteractions(props.thread.id);
  const asking = !!open?.length;
  // A question is answered on its card, so Stop never sits in the send slot while one waits.
  const questioned = question.placeholder !== undefined;
  const canStop = activityState.canStop && !questioned;
  // Esc never stops on its own: the first press asks in the strip, a second one soon stops.
  const [armedAt, setArmedAt] = useState<number>();
  const armed = canStop && armedAt !== undefined;
  useEffect(() => {
    if (!canStop || armedAt === undefined) return;
    const expire = setTimeout(() => setArmedAt(undefined), stopKeyWindowMs);
    return () => clearTimeout(expire);
  }, [canStop, armedAt]);
  const stopKey = (at: number) => {
    const again =
      armed && armedAt !== undefined && at >= armedAt && at - armedAt <= stopKeyWindowMs;
    setArmedAt(again ? undefined : at);
    if (again) stop();
  };
  const subagents = meta ? (meta.live?.runningSubagentCount ?? runningSubagents(meta.status)) : 0;
  // While the strip shows what the agent only waits on, Stop sits there instead of the send slot.
  const [waitingShown, setWaitingShown] = useState(false);
  const waiting = waitingShown && canStop;
  const toMessage = () =>
    box.current
      ?.querySelector<HTMLElement>('[role="combobox"][contenteditable]')
      ?.focus({ preventScroll: true });
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
  // The palette's Stop, Switch model and Effort act through these.
  useComposerActions(props.thread.id, canStop ? stop : undefined, {
    chooseModel: () => requestPicker((count) => count + 1),
    tuneEffort: () => requestTune((count) => count + 1),
  });

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
    <ComposerDock ref={box}>
      <Composer
        ref={composer}
        thread={props.thread}
        draftKey={`thread:${props.thread.id}`}
        placeholder={question.placeholder}
        keepsAttachments
        busy={busy}
        followUp={followUp}
        canSteer={canSteer}
        onSubmit={submit}
        recall={(older) => (transcript ? sentText(transcript, older) : undefined)}
        onStop={canStop ? stop : undefined}
        onStopKey={stopKey}
        stopping={stopping}
        stopInStrip={waiting}
        sendsNow={sendsNow}
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
            <DeferredComposerStrip.Component
              key={props.thread.id}
              threadId={props.thread.id}
              status={props.status}
              confirmStop={armed ? { subagents } : undefined}
              onStop={canStop ? stop : undefined}
              stopping={stopping}
              onWaitingShown={setWaitingShown}
              requestTarget={props.requestTarget}
              onLeave={toMessage}
              onChooseModel={() => requestPicker((count) => count + 1)}
            />
          </Suspense>
        }
        controls={
          <Suspense fallback={<ControlsPending />}>
            <DeferredPermissionControl.Component thread={props.thread} />
          </Suspense>
        }
        trailing={
          <Suspense fallback={<ControlsPending />}>
            <DeferredModelControl.Component
              thread={props.thread}
              busy={busy}
              next={next}
              continued={continued}
              pickerRequest={pickerRequest}
              tuneRequest={tuneRequest}
            />
          </Suspense>
        }
      />
    </ComposerDock>
  );
}
