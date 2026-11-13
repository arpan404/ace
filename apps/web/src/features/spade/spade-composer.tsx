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
 * The thread composer as ace's capsule, sending to Spade: +, the field, and one button at its
 * end: the mic while it is empty, Send once there are words, Stop while the bot works and the
 * draft is empty. A message always sends: while a reply runs it steers it. Files attach as they
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
  /** Stops the bot; with it, Stop takes the end of an empty capsule while the bot works. */
  onStop?: (() => void) | undefined;
  stopping?: boolean | undefined;
  /** Words to start with, one tap each ("Ask Inbox"), shown above the composer. */
  chips?: readonly { label: string; text: string; face: ReactNode }[] | undefined;
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
        onStop={props.onStop}
        stopping={props.stopping}
        stopInStrip={!props.onStop}
        capsule
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
        idleAction={<MicButton voice={voice} />}
        attached={
          <>
            {props.chips && props.chips.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5 px-1">
                {props.chips.map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    onClick={() => composer.current?.insertText(chip.text)}
                    className="flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-ui text-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover"
                  >
                    {chip.face}
                    {chip.label}
                  </button>
                ))}
              </div>
            )}
            {props.attached}
            <VoiceStrip voice={voice} />
          </>
        }
        onSubmit={submit}
      />
    </ComposerDock>
  );
}
