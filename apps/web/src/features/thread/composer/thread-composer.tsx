import { useClient, useIntent, useInteractions, useThreadMeta } from "@ace/client-react";
import { useComposerActions } from "./composer-actions.ts";
import type { Interaction, ThreadStatus } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import {
  modelLabel,
  providerNames,
  threadIsRunning,
  selectionInputs,
  currentModelChoice,
  resolveEffort,
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
import { UsageNotice } from "./usage-notice.tsx";
import { runsOn, changedTurnOptions, selectionIdentity, type PendingTurn } from "./execution.ts";
import { clearStop, recordStop, useStopFence, useStopping } from "./stop-state.ts";

/** The send pipeline's code: fetched when a composer mounts, so the first Enter never waits on it. */
let sender: Promise<typeof import("./send-message.ts")> | undefined;
const loadSender = () => (sender ??= import("./send-message.ts"));

/** Desktop widths put the caret in the composer when a thread opens; a phone's keyboard waits. */
const wideEnoughToFocus = () =>
  typeof matchMedia === "function" && matchMedia("(min-width: 768px)").matches;

/** How soon after the first Esc a second one stops the agent tree. */
export const stopKeyWindowMs = 1_500;

const pendingQuestion = (interaction: Interaction) =>
  interaction.state === "pending" && interaction.request.kind === "question";

/** The agent is mid-turn or held up: a new message follows up rather than starting a turn. */
export function isBusy(status: ThreadStatus | undefined): boolean {
  return threadIsRunning(status) || status?.state === "limited";
}

/**
 * The thread's composer, on the transcript's column. Enter sends: the message shows as its
 * bubble at once and goes through the client's outbox under its own command id. While the agent
 * works a message follows up the way the daemon's `threads.followUpBehavior` says (queue by
 * default), and ⌘↵ / Ctrl+↵ does the opposite where the provider can steer. Its footer shows
 * how actions are approved and the model, both changeable from the next turn. Nothing sits below
 * it; one strip sits above it (`ComposerStrip`): the agent's open requests (answered on their
 * card there), the connection, the queue or the plan. Stop is in the send slot while the
 * composer is empty, and never while a question waits. The unsent draft is kept per thread.
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
  const modelChoices = useModelChoices();
  const [setting] = useDaemonSetting("threads.followUpBehavior", {
    threadId: ThreadId.parse(props.thread.id),
  });
  // Steering needs a provider that says it can take input mid-turn; otherwise (or while its
  // capabilities are unknown) a follow-up queues (SY-14).
  const canSteer = meta?.capabilities?.steer === true;
  const followUp = canSteer ? setting : "queue";
  const busy = isBusy(props.status);
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
  // What a follow-up without options inherits: a switch waiting for the next turn, else what
  // runs now. Options are sent only where they differ from it.
  const inherited = runsOn(meta);
  const pendingModel = currentModelChoice(modelChoices, inherited);
  const inheritedEffort = resolveEffort(
    pendingModel?.efforts ?? [],
    typeof inherited?.options?.["effort"] === "string" ? inherited.options["effort"] : undefined,
    pendingModel?.defaultEffort,
  );
  const pendingEffort =
    sent &&
    resolveEffort(
      pendingModel?.efforts ?? [],
      typeof sent.options["effort"] === "string" ? sent.options["effort"] : undefined,
      pendingModel?.defaultEffort,
    );
  const pendingOptions = sent && {
    ...sent.options,
    ...(pendingEffort !== undefined ? { effort: pendingEffort } : {}),
  };
  const followUpOptions = changedTurnOptions(pendingOptions, {
    ...inherited?.options,
    ...(inheritedEffort !== undefined ? { effort: inheritedEffort } : {}),
  });
  const selectionWaiting = busy && (!!followUpOptions || meta?.switch?.state === "queued");

  const submit = async (draft: Draft) => {
    // Never send options picked for another selection; the controls are re-checking them.
    const commandId = crypto.randomUUID();
    // While the agent works the delivery is said outright, so this window knows at once
    // whether the message is a bubble (steered in) or a pill (queued).
    const other = followUp === "steer" ? "queue" : "steer";
    const delivery = busy
      ? selectionWaiting
        ? "queue"
        : draft.opposite
          ? other
          : (followUp ?? "queue")
      : undefined;
    const selection = runsOn(meta);
    const model = currentModelChoice(modelChoices, selection);
    const explicit = sent?.options ?? selection?.options;
    const effort = resolveEffort(
      model?.efforts ?? [],
      typeof explicit?.["effort"] === "string" ? explicit["effort"] : undefined,
      model?.defaultEffort,
    );
    // Steering leaves the running turn intact; its next admission resolves the same default.
    const options = busy
      ? followUpOptions
      : delivery !== "steer" &&
          effort !== undefined &&
          (explicit?.["effort"] === undefined ||
            model?.efforts.includes(String(explicit["effort"])))
        ? { ...(sent?.options ?? selection?.options), effort }
        : sent?.options;
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
  const questioned = !!useInteractions(props.thread.id, pendingQuestion)?.length;
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
        keepsAttachments
        busy={busy}
        followUp={selectionWaiting ? "queue" : followUp}
        canSteer={canSteer && !selectionWaiting}
        onSubmit={submit}
        onStop={canStop ? stop : undefined}
        onStopKey={stopKey}
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
            <UsageNotice threadId={props.thread.id} />
            <DeferredComposerStrip.Component
              key={props.thread.id}
              threadId={props.thread.id}
              status={props.status}
              confirmStop={armed ? { subagents } : undefined}
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
              pickerRequest={pickerRequest}
              tuneRequest={tuneRequest}
            />
          </Suspense>
        }
      />
    </ComposerDock>
  );
}
