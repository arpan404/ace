import { useId, type ReactNode } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { Composer, ComposerDock, type Draft } from "@/features/thread/index.ts";
import { prepareSpadeImages, type SpadeMessage } from "./spade-images.ts";

/** Spade's composer has no project or commands of its own: the person's words and images. */
const spadeThread = { id: "", workspaceId: "", title: "", draft: true } as const;

/**
 * The thread composer, sending to Spade. It always sends: while a reply runs the message steers
 * it, so it never turns into Stop or Queue (Stop is on the Working line). Images attach as they
 * do in a thread; any other file is put back with a note. Until Spade runs, sending says why.
 */
export function SpadeComposer(props: {
  draftKey: string;
  answering: boolean;
  /** Why nothing can be sent yet (Spade is off or starting). */
  blocked: string | undefined;
  placeholder: string;
  attached?: ReactNode;
  send(message: SpadeMessage): Promise<void>;
}) {
  const toast = useToast();
  const reason = useId();
  const submit = async (draft: Draft) => {
    const text = draft.text.trim();
    const files = draft.files.files.filter((file) => file !== undefined);
    if (!text && !draft.files.local.length) return false;
    try {
      // A file restored from a saved draft has no bytes in this window any more.
      if (files.length !== draft.files.local.length)
        throw new Error("Attach the images again to send them to Spade.");
      const images = await prepareSpadeImages(files);
      await props.send({ text, images });
      draft.files.release();
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
        // Spade reads the files from this window; with no thread they never upload to the daemon.
        sendsWhileUploading
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
