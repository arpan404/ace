import { useId, type ReactNode } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { Composer, ComposerDock, type Draft } from "@/features/thread/index.ts";

/** Spade's composer has no project, files or commands of its own: just the person's words. */
const spadeThread = { id: "", workspaceId: "", title: "", draft: true } as const;

/**
 * The thread composer, sending to Spade. It always sends: while a reply runs the message steers
 * it, so it never turns into Stop or Queue (Stop is on the Working line). Spade takes text only
 * for now, so a message with files is put back with a note. Until Spade runs, sending says why.
 */
export function SpadeComposer(props: {
  draftKey: string;
  answering: boolean;
  /** Why nothing can be sent yet (Spade is off or starting). */
  blocked: string | undefined;
  placeholder: string;
  attached?: ReactNode;
  send(text: string): Promise<void>;
}) {
  const toast = useToast();
  const reason = useId();
  const submit = async (draft: Draft) => {
    if (draft.files.local.length) {
      toast.error({
        title: "Spade takes text only for now",
        description: "Remove the files to send.",
      });
      return false;
    }
    const text = draft.text.trim();
    if (!text) return false;
    try {
      await props.send(text);
      return true;
    } catch (error) {
      toast.error({
        title: "Couldn't send to Spade",
        description: error instanceof Error ? error.message : undefined,
      });
      return false;
    }
  };
  return (
    <ComposerDock>
      {props.blocked && (
        <p id={reason} className="sr-only">
          {props.blocked}
        </p>
      )}
      <Composer
        thread={spadeThread}
        draftKey={props.draftKey}
        busy={props.answering}
        sendsNow
        stopInStrip
        followUp="steer"
        autoFocus
        typeToFocus
        label="Message Spade"
        placeholder={props.placeholder}
        shortPlaceholder="Message Spade"
        sendBlocked={props.blocked ? { reason: props.blocked, describedBy: reason } : undefined}
        attached={props.attached}
        onSubmit={submit}
      />
    </ComposerDock>
  );
}
