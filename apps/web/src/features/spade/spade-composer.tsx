import { spadeQuoted } from "@ace/ui-core/spade-chat";
import { XIcon } from "@ace/icons";
import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import {
  Composer,
  ComposerDock,
  type ComposerHandle,
  type Draft,
  useStopKey,
} from "@/features/thread/index.ts";
import { prepareSpadeFiles, type SpadeMessage } from "./spade-attachments.ts";
import { MicButton, TalkLine, useSpadeVoice, VoiceButton, VoiceStrip } from "./spade-mic.tsx";
import { onPushToTalk, reportPushToTalk, type PushPhase } from "./spade-push-to-talk.ts";
import { useTalkMode } from "./spade-talk-mode.ts";
import { useSpadeModels } from "./use-spade-models.ts";

/** A bot's composer has no project or commands of its own: the person's words and files. */
const spadeThread = { id: "", workspaceId: "", title: "", draft: true } as const;

/**
 * The thread composer as ace's capsule, sending to Spade, its controls round at the Spade size:
 * +, the field, the mic for dictation, and one filled button at its end: a hands-free spoken
 * conversation while the field is empty, Send once there are words, Stop while the bot works and
 * the draft is empty. While the conversation lasts, one quiet line above says where it is. The
 * main Spade's composer also answers the desktop's push-to-talk shortcut. A message always sends: while a reply runs it steers it. Files attach as they
 * do in a thread: images go as images, anything else as a document Spade reads (ADR 0134). The
 * mic records a voice message whose words land here to be checked. Until Spade runs, sending
 * says why. While the bot has no model it can use, sending is held: one line above the field says
 * so, with Set up a model beside it. ↑ in the empty field brings back what the person last sent, to
 * change and send again; Esc twice stops the bot, as in a thread.
 */
export function SpadeComposer(props: {
  /** The bot it sends to. */
  name: string;
  draftKey: string;
  answering: boolean;
  /** Why nothing can be sent yet (Spade is off or starting). */
  blocked: string | undefined;
  /** The bot has no model it can use: sending waits, and this sets one up. */
  needsModel?: { onSetUp(): void } | undefined;
  placeholder: string;
  attached?: ReactNode;
  /** Stops the bot; with it, Stop takes the end of an empty capsule while the bot works. */
  onStop?: (() => void) | undefined;
  /** What the person wrote `older` messages back, for ↑ in the empty field to bring back. */
  recall?: ((older: number) => string | undefined) | undefined;
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
  /** What sits under the capsule: a new bot's templates and its More settings. */
  below?: ReactNode;
  send(message: SpadeMessage): Promise<void>;
  /** A message the person spoke is going: its reply is read aloud. */
  onSpoken?: (() => void) | undefined;
  /** This is the main Spade, which push to talk speaks to. */
  main?: boolean | undefined;
}) {
  const toast = useToast();
  const reason = useId();
  const held = props.needsModel ? `${props.name} needs a model before it can answer.` : undefined;
  const blocked = props.blocked ?? held;
  const composer = useRef<ComposerHandle>(null);
  // The transcription model the person chose, if any: the mic's way when the device has none.
  const models = useSpadeModels(props.blocked === undefined);
  const voice = useSpadeVoice({
    transcriptionModel: models.data?.transcriptionModel,
    onWords: (words) => composer.current?.insertText(words),
  });
  // A spoken conversation: what the person says goes as it is, without a stop in the field.
  const talk = useTalkMode({
    recognize: voice.recognize,
    transcriptionModel: models.data?.transcriptionModel,
    answering: props.answering,
    // Push to talk: the desktop's indicator follows the turn.
    changed: (state, push) => {
      if (push) reportPushToTalk(state.kind);
    },
    send: async (words, recording) => {
      if (blocked) {
        toast.error({ title: `Couldn't send to ${props.name}`, description: blocked });
        return false;
      }
      try {
        props.onSpoken?.();
        await props.send({ text: words, images: [], documents: [], voice: recording });
        return true;
      } catch (error) {
        toast.error({
          title: `Couldn't send to ${props.name}`,
          description: error instanceof Error ? error.message : undefined,
        });
        return false;
      }
    },
  });
  // Push to talk, on the main Spade: the first press listens, the next sends.
  const pressed = useEffectEvent((phase: PushPhase) => {
    if (phase === "cancel") return talk.end();
    if (phase === "send") return talk.sendNow();
    // Over Spade's answer, a press stops it and listens again.
    if (talk.state.kind === "thinking" || talk.state.kind === "speaking") {
      talk.end();
      talk.push();
      return;
    }
    // The desktop says send for a second press; a start while listening is the same press.
    if (talk.state.kind !== "off") return;
    if (voice.needsSetup) {
      reportPushToTalk("off");
      return voice.openSetup();
    }
    talk.push();
  });
  const main = props.main === true;
  useEffect(() => (main ? onPushToTalk((phase) => pressed(phase)) : undefined), [main]);
  const quoted = props.quote?.text;
  // Esc twice stops, as in a thread: the first press only says so above the field.
  const onStop = props.onStop;
  const { armed, stopKey } = useStopKey(
    props.answering && onStop !== undefined && !props.stopping,
    () => onStop?.(),
  );
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
      // Words the person spoke are answered aloud.
      if (recording) props.onSpoken?.();
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
      {/*
        The capsule grows in place: its buttons stay at the bottom edge as the words wrap, and the
        field keeps the same room above and below its first line.
      */}
      <div className="[--composer-control:var(--spade-composer-button)] [&_[data-slot=composer][data-pill]]:min-h-13 [&_[data-slot=composer][data-pill]]:items-end [&_[data-slot=composer][data-pill]]:rounded-[1.625rem] [&_[data-slot=composer][data-pill]]:pb-1.5 [&_[data-slot=composer][data-pill]>[data-slot=composer-input]]:pt-4 [&_[data-slot=composer][data-pill]>[data-slot=composer-input]]:pb-2.5">
        {props.blocked && (
          <p id={reason} className="sr-only">
            {props.blocked}
          </p>
        )}
        {armed && (
          <p role="status" className="mb-2 px-1 text-center text-ui text-muted-foreground">
            {`Esc again to stop ${props.name}`}
          </p>
        )}
        {!armed && !props.blocked && props.needsModel && (
          <p className="mb-2 flex flex-wrap items-center justify-center gap-x-1 px-1 text-ui text-muted-foreground">
            <span id={reason}>{held}</span>
            <Button size="xs" variant="ghost" onClick={props.needsModel.onSetUp}>
              Set up a model
            </Button>
          </p>
        )}
        <Composer
          ref={composer}
          thread={spadeThread}
          draftKey={props.draftKey}
          busy={props.answering}
          sendsNow
          onStop={props.onStop}
          onStopKey={stopKey}
          recall={props.recall}
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
          sendBlocked={blocked ? { reason: blocked, describedBy: reason } : undefined}
          trailing={<MicButton voice={voice} />}
          idleAction={<VoiceButton name={props.name} talk={talk} voice={voice} />}
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
              <TalkLine name={props.name} talk={talk} push={talk.pushing} />
            </>
          }
          onSubmit={submit}
        />
        {props.below}
      </div>
    </ComposerDock>
  );
}
