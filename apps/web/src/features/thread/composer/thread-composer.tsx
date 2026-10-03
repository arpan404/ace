import { useClient, useThreadMeta } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import { useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage } from "@/lib/daemon-command.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useToastClearance } from "@/lib/toast-clearance.ts";
import { choiceSelection, currentModelChoice, type ModelChoice } from "@ace/ui-core";
import { useModelChoices } from "@/features/models/index.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { SwitchDialog } from "../transitions/switch-dialog.tsx";
import { Composer, type Draft } from "./composer.tsx";
import { ContextBar } from "./context-bar.tsx";
import { ContextMeter } from "./context-meter.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { QueueNotice } from "./queue-notice.tsx";
import { QueuedPills } from "./queued.tsx";
import { useQueue } from "./use-queue.ts";

/** The agent is mid-turn or held up: a new message follows up rather than starting a turn. */
export function isBusy(status: ThreadStatus | undefined): boolean {
  if (!status) return false;
  if (status.state === "working" || status.state === "needs_you" || status.state === "limited")
    return true;
  return status.state === "waiting" && status.on !== "background_task";
}

/**
 * The thread's composer. Enter sends; while the agent works a message follows up the way the
 * daemon's `threads.followUpBehavior` says (queue by default), and ⌘↵ / Ctrl+↵ does the
 * opposite. Queued messages wait on the daemon's queue as pills above, with the reason when the
 * queue is held (a usage limit, a restart). Stop interrupts the agent and its subagents.
 */
export function ThreadComposer(props: { thread: ThreadRef; status: ThreadStatus | undefined }) {
  const client = useClient();
  const sources = useThreadSources();
  const toast = useToast();
  const meta = useThreadMeta(props.thread.id);
  const queue = useQueue(props.thread.id);
  const [followUp] = useDaemonSetting("threads.followUpBehavior", {
    threadId: ThreadId.parse(props.thread.id),
  });
  const choices = useModelChoices();
  const [switching, setSwitching] = useState<ModelChoice>();
  const busy = isBusy(props.status);
  const threadId = ThreadId.parse(props.thread.id);
  // Toasts (a thread elsewhere needs you, Undo) rise above the composer, never over it.
  const box = useRef<HTMLDivElement>(null);
  useToastClearance(box);

  const pending = meta?.switch?.state === "queued" ? meta.switch.selection : undefined;
  const runsOn =
    pending ??
    meta?.execution ??
    (meta && {
      provider: meta.provider,
      model: meta.live?.model,
      instanceId: meta.live?.account,
    });
  const current = currentModelChoice(choices, runsOn);

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
  const switchTo = (choice: ModelChoice) => {
    setSwitching(undefined);
    sources.actions.switchTo(props.thread, choiceSelection(choice)).then(
      () =>
        toast.add({
          title: busy
            ? `Switches to ${choice.model} after this turn`
            : `Continues on ${choice.model}`,
        }),
      (error: unknown) =>
        toast.add({ title: "Couldn't switch the model", description: failureMessage(error) }),
    );
  };

  return (
    // The backdrop runs from 2.5rem above the composer to the bottom edge and fades in over
    // its first 2.5rem, so transcript text dissolves under it with no band edge.
    <div
      ref={box}
      className="relative flex-none px-4 pb-3.5 sm:px-8 before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:bottom-0 before:bg-reading before:[mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)]"
    >
      <div className="relative mx-auto max-w-(--column)">
        <QueueNotice threadId={props.thread.id} status={props.status} queue={queue} />
        <QueuedPills queue={queue} />
        <Composer
          thread={props.thread}
          busy={busy}
          followUp={followUp}
          onSubmit={submit}
          onStop={stop}
          controls={
            <>
              <ContextMeter threadId={props.thread.id} />
              <ModelPicker
                choices={choices}
                value={current}
                onChange={(choice) => {
                  if (choice.id === current?.id) return;
                  // Another provider starts without the agent's private working state: say so.
                  if (meta && choice.provider !== (runsOn?.provider ?? meta.provider))
                    setSwitching(choice);
                  else switchTo(choice);
                }}
              />
            </>
          }
        />
        <ContextBar thread={props.thread} />
      </div>
      {switching && meta && (
        <SwitchDialog
          from={runsOn?.provider ?? meta.provider}
          to={switching}
          busy={busy}
          onConfirm={() => switchTo(switching)}
          onClose={() => setSwitching(undefined)}
        />
      )}
    </div>
  );
}
