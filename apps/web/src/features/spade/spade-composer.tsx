import { spadeQuoted } from "@ace/ui-core/spade-chat";
import { XIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import {
  Composer,
  ComposerDock,
  type ComposerHandle,
  type Draft,
} from "@/features/thread/index.ts";
import { prepareSpadeFiles, type SpadeMessage } from "./spade-attachments.ts";
import { MicButton, useSpadeVoice, VoiceButton, VoiceStrip } from "./spade-mic.tsx";
import { useSpadeModels } from "./use-spade-models.ts";

/** A bot's composer has no project or commands of its own: the person's words and files. */
const spadeThread = { id: "", workspaceId: "", title: "", draft: true } as const;

/**
 * The thread composer as ace's capsule, sending to Spade, its controls round at the Spade size:
 * +, the field, the mic for dictation, and one filled button at its end: voice while the field is
 * empty (off until voice ships), Send once there are words, Stop while the bot works and the
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
  /**
   * What the next message answers (a decision the person wants changed): above the field, and
   * quoted before their words when it goes.
   */
  quote?: { text: string; onRemove(): void } | undefined;
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
  const quoted = props.quote?.text;
  // A new quote puts the caret in the field, to say what they want instead.
  useEffect(() => {
    if (quoted) composer.current?.focus();
  }, [quoted]);
  const submit = async (draft: Draft) => {
    const words = draft.text.trim();
    const text = quoted && words ? spadeQuoted(quoted, words) : words;
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
      if (quoted && words) props.quote?.onRemove();
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
      <div className="[--composer-control:var(--spade-composer-button)] [&_[data-slot=composer][data-pill]]:min-h-13">
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
          trailing={<MicButton voice={voice} />}
          idleAction={<VoiceButton name={props.name} />}
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
              {props.quote && (
                <div className="mb-2 flex px-1">
                  <span className="flex h-8 max-w-full min-w-0 items-center gap-1 rounded-full bg-secondary pr-1 pl-3 text-ui text-foreground">
                    <span className="truncate">{props.quote.text}</span>
                    <button
                      type="button"
                      aria-label="Remove quote"
                      onClick={props.quote.onRemove}
                      className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground focus-ring hover:bg-hover hover:text-foreground"
                    >
                      <Icon icon={XIcon} size={14} />
                    </button>
                  </span>
                </div>
              )}
              {props.attached}
              <VoiceStrip voice={voice} />
            </>
          }
          onSubmit={submit}
        />
      </div>
    </ComposerDock>
  );
}
