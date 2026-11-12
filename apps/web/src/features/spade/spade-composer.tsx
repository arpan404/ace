import { useId, useRef, type ReactNode } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import {
  Composer,
  ComposerDock,
  type ComposerHandle,
  type Draft,
} from "@/features/thread/index.ts";
import { prepareSpadeFiles, type SpadeMessage } from "./spade-attachments.ts";
import { MicButton, useSpadeVoice, VoiceStrip } from "./spade-mic.tsx";
import { useSpadeModels } from "./use-spade-models.ts";

/** A bot's composer has no project or commands of its own: the person's words and files. */
const spadeThread = { id: "", workspaceId: "", title: "", draft: true } as const;

/**
 * The thread composer, sending to Spade. It always sends: while a reply runs the message steers
 * it, so it never turns into Stop or Queue (Stop is on the Working line). Files attach as they
 * do in a thread: images go as images, anything else as a document Spade reads (ADR 0134). The
 * mic records a voice message whose words land here to be checked. Until Spade runs, sending
 * says why.
 */
export function SpadeComposer(props: {
  /** The bot it sends to. */
  name: string;
  draftKey: string;
  answering: boolean;
  /** Why nothing can be sent yet (Spade is off or starting). */
  blocked: string | undefined;
  placeholder: string;
  attached?: ReactNode;
  /** Names `@` offers (a group's members), inserted as plain text. */
  mentionNames?: readonly string[] | undefined;
  send(message: SpadeMessage): Promise<void>;
}) {
  const toast = useToast();
  const reason = useId();
  const composer = useRef<ComposerHandle>(null);
  // The transcription model the person chose, if any: the mic's way when the device has none.
  const models = useSpadeModels(props.blocked === undefined);
  const voice = useSpadeVoice({
    transcriptionModel: models.data?.transcriptionModel,
    onWords: (words) => composer.current?.insertText(words),
  });
  const submit = async (draft: Draft) => {
    const text = draft.text.trim();
    const files = draft.files.files.filter((file) => file !== undefined);
    if (!text && !draft.files.local.length) return false;
    try {
      // A file restored from a saved draft has no bytes in this window any more.
      if (files.length !== draft.files.local.length)
        throw new Error("Attach the files again to send them to Spade.");
      const { images, documents } = await prepareSpadeFiles(files);
      // A recording goes with the words it became; with no words left, it stays behind.
      const recording = text ? voice.voice : undefined;
      await props.send({ text, images, documents, voice: recording });
      draft.files.release();
      if (recording) voice.remove();
      return true;
    } catch (error) {
      toast.error({
        title: `Couldn't send to ${props.name}`,
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
        ref={composer}
        thread={spadeThread}
        draftKey={props.draftKey}
        busy={props.answering}
        sendsNow
        stopInStrip
        followUp="steer"
        // Spade reads the files from this window; with no thread they never upload to the daemon.
        sendsWhileUploading
        filesOnly
        mentionNames={props.mentionNames}
        autoFocus
        typeToFocus
        label={`Message ${props.name}`}
        placeholder={props.placeholder}
        shortPlaceholder={`Message ${props.name}`}
        sendBlocked={props.blocked ? { reason: props.blocked, describedBy: reason } : undefined}
        controls={<MicButton voice={voice} />}
        attached={
          <>
            {props.attached}
            <VoiceStrip voice={voice} />
          </>
        }
        onSubmit={submit}
      />
    </ComposerDock>
  );
}
