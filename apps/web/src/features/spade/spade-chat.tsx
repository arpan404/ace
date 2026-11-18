import type { BotFaceState } from "@ace/ui-core/bot-face";
import {
  type SpadeTaskLine,
  parseSpadeAvatar,
  spadeBubbles,
  spadeChatRows,
  spadePlainText,
  type SpadeChatRow,
  withProposals,
  type SpadeAvatar,
  type SpadeChatItem,
  type SpadeProposal,
  type SpadeView,
  spadeQuietLine,
  spadeRestLine,
  withSpadeDigests,
  type SpadeDigest,
  type SpadeRestAction,
} from "@ace/ui-core/spade-chat";
import { memo, useMemo } from "react";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { useSeconds } from "@/lib/time.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import { chatBubble, framed, mineBubble } from "./spade-bubble-style.ts";
import { BubbleFrame, Failure, FileChips, SpeakerLine, WorkingLine } from "./spade-chat-parts.tsx";
import { SkillProposal } from "./spade-skill-bubble.tsx";
import { SpadeHelperLine } from "./spade-helper-line.tsx";
import { SpadeRequestBubble, type RequestAnswer } from "./spade-request-bubble.tsx";
import { SpadeOutsideBubble } from "./spade-outside-bubble.tsx";
import { SpadeQuestionBubble } from "./spade-question-bubble.tsx";
import type { QuestionReply } from "./use-spade-conversation.ts";
import { DocumentChips, Pictures, VoicePlay } from "./spade-media.tsx";
import { QuietLine, RestingLine } from "./spade-quiet-line.tsx";
import { SpadeDigestBubble } from "./spade-digest-bubble.tsx";
import { SpadeStepsLine } from "./spade-steps-line.tsx";

/** The bot whose conversation this is, and the faces of other bots that write into it. */
export interface ChatBot {
  id: string;
  name: string;
  avatar: SpadeAvatar;
  /** Other bots by id, for the faces of messages they send here. */
  others: ReadonlyMap<string, SpadeAvatar>;
  /** Every bot's name by id, for a request to message one. */
  names: ReadonlyMap<string, string>;
}

/**
 * A bot's conversation as a messenger (ADR 0127, docs/design/spade.md §3): the person's bubbles
 * on the right in the accent, the bot's filled on the left in runs (`spadeChatRows`), with no
 * face beside them (the pill and the working line carry it); a time line only after a pause or
 * on a new day, a routine's run named in its line; messages other bots sent here under their
 * face and name. Each bubble offers its exact time, Copy and Read aloud on hover or a long
 * press. Each thing the bot says is a bubble of its own, stacked as a messenger shows several
 * messages; under a reply, the steps it took fold into one quiet line that opens to each, with
 * what was blocked, refused, hard to undo or done outside its box shown unopened
 * (`SpadeStepsLine`). Jobs, compaction and the notes it saves don't show (ADR 0128). A request
 * is the bot's bubble after the step that asked, with Allow and Deny, and keeps its answer once
 * given (`SpadeRequestBubble`); a card of questions likewise, answered in it or left for later
 * (`SpadeQuestionBubble`, ADR 0154); a search with nothing set up shows nothing (Settings ›
 * Spade › Web search is where it is set up); and a skill the bot offers as a
 * bubble with Save and Discard (ADR 0130), after the reply that made it. While the bot works, one line under its last bubble: its face
 * working, its few words and how long it has been at it, with Watch while it uses its computer
 * and the right panel is closed. A bot carrying on with its task by itself keeps that line between replies ("Flights is
 * working on it · its step"), and a task waiting on the person reads "Flights needs you" (the
 * request is its bubble above). Stop is the composer's; a done task shows nothing more.
 */
export function SpadeChat(props: {
  bot: ChatBot;
  view: SpadeView;
  /** It uses its computer and the panel is closed: the working line offers to watch it. */
  onWatch?: (() => void) | undefined;
  /** The person has the bot's computer: Spade pauses the bot, and the line says so. */
  paused?: boolean | undefined;
  /** Its task's line (`spadeTaskLine`): carrying on by itself, waiting, or waiting on the person. */
  task?: SpadeTaskLine | undefined;
  /** Answer a request: allow once, allow always, or deny. */
  onAnswer(callId: string, answer: RequestAnswer): Promise<boolean>;
  /**
   * Answer a plugin asking to run outside the sandbox (ADR 0167): allow once, always for this
   * plugin version, or deny.
   */
  onAnswerOutside?(id: string, answer: RequestAnswer): Promise<boolean>;
  /** Reply to a card of questions; resolves with what to say under it when refused. */
  onQuestion(callId: string, reply: QuestionReply): Promise<string | undefined>;
  /** A file chip: open that file of the bot's workspace. */
  onOpenFile(path: string): void;
  proposals?: readonly SpadeProposal[];
  onProposal?(id: string, save: boolean): Promise<boolean>;
  /** An endpoint's name by its id, for a failed reply's sentence; undefined when unknown. */
  endpointName?(id: string): string | undefined;
  /** Try again on a failed reply: sends the person's last message again. */
  onRetry?(text: string): Promise<boolean>;
  /** Its digests (ADR 0165), oldest first: messages of its own where each was made. */
  digests?: readonly SpadeDigest[] | undefined;
  /** The resting line's actions on its wake; resolves false when it didn't go through. */
  onWake?(wake: string, action: SpadeRestAction): Promise<boolean>;
  /** Open another bot's conversation: a worker's quiet line opens it. */
  onOpenBot?(id: string): void;
  /** Open its profile's Work tab: a goal's and a check's quiet lines open it. */
  onOpenWork?(): void;
}) {
  const { view, bot } = props;
  // Days change rarely: the clock as it stands is enough for Today and Yesterday.
  const now = useSeconds(false);
  const proposals = props.proposals;
  const digests = props.digests;
  const rows = useMemo(
    () =>
      // The notes it saves stay in its Memory dialog, never in the chat.
      spadeChatRows(
        withSpadeDigests(
          withProposals(spadeBubbles(view), view.entries, proposals ?? []).filter(
            (item) => item.kind !== "remembered",
          ),
          digests ?? [],
        ),
        { now },
      ),
    [view, proposals, digests, now],
  );
  // Asleep or waiting on a wake: the resting line takes the working line's place (ADR 0160).
  const rest =
    view.resting &&
    spadeRestLine(
      view.resting,
      {
        worker: (id) => view.workers.get(id),
        service: (id) => view.services.get(id),
        bot: (id) => bot.names.get(id),
      },
      { now },
    );
  const onWake = props.onWake;
  // Busy: anything open. Stop stays while it is, waiting on the person too; the face moves only
  // while the bot works itself.
  const busy = view.busy;
  const waiting = view.approvals.length > 0 || view.asking;
  const lineState: BotFaceState = waiting
    ? "needs-you"
    : view.status === "Thinking"
      ? "thinking"
      : "working";
  // The working line shows while the bot works itself, not while it waits on the person; a
  // task that carries on or waits on the person keeps its line between replies too.
  const working = busy && !waiting;
  const task = props.task;
  const lined = working || task !== undefined;
  const handlers: Handlers = {
    endpointName: props.endpointName,
    onProposal: props.onProposal,
    onAnswer: props.onAnswer,
    onAnswerOutside: props.onAnswerOutside,
    onQuestion: props.onQuestion,
    onOpenFile: props.onOpenFile,
    onRetry: props.onRetry,
    onOpenBot: props.onOpenBot,
    onOpenWork: props.onOpenWork,
    face: (id) => bot.others.get(id) ?? parseSpadeAvatar(undefined, id),
  };
  return (
    <div
      role="feed"
      aria-label={`Conversation with ${bot.name}`}
      aria-busy={view.busy}
      className="flex flex-col"
    >
      {rows.map((row, index) => (
        <Row key={row.key} row={row} previous={rows[index - 1]} bot={bot} handlers={handlers} />
      ))}
      {rest && !props.paused && onWake ? (
        <RestingLine
          avatar={bot.avatar}
          line={rest}
          onAction={(action) => onWake(rest.wake, action)}
        />
      ) : (
        lined &&
        (props.paused ? (
          // Paused by Spade while the person drives: nothing runs, so no clock.
          <WorkingLine
            avatar={bot.avatar}
            state="idle"
            label="Paused while you have the computer"
            since={undefined}
            onWatch={undefined}
          />
        ) : task?.tone === "needs-you" ? (
          <WorkingLine
            avatar={bot.avatar}
            state="needs-you"
            label={task.sentence}
            since={undefined}
            onWatch={undefined}
          />
        ) : task?.tone === "waiting" && !working ? (
          // Waiting on something other than the person: it says so, with no spinner or clock.
          <WorkingLine
            avatar={bot.avatar}
            state="idle"
            label={[task.sentence, task.step].filter(Boolean).join(" · ")}
            since={undefined}
            onWatch={undefined}
          />
        ) : (
          <WorkingLine
            avatar={bot.avatar}
            state={task && !working ? "working" : lineState}
            label={
              task && task.tone !== "waiting"
                ? [task.sentence, task.step].filter(Boolean).join(" · ")
                : (view.status ?? "Working")
            }
            since={working ? view.working?.since : undefined}
            onWatch={props.onWatch}
          />
        ))
      )}
    </div>
  );
}

interface Handlers {
  endpointName: ((id: string) => string | undefined) | undefined;
  onProposal: ((id: string, save: boolean) => Promise<boolean>) | undefined;
  onAnswer(callId: string, answer: RequestAnswer): Promise<boolean>;
  onAnswerOutside: ((id: string, answer: RequestAnswer) => Promise<boolean>) | undefined;
  /** Reply to a card of questions; resolves with what to say under it when refused. */
  onQuestion(callId: string, reply: QuestionReply): Promise<string | undefined>;
  onOpenFile(path: string): void;
  onRetry: ((text: string) => Promise<boolean>) | undefined;
  onOpenBot: ((id: string) => void) | undefined;
  onOpenWork: (() => void) | undefined;
  /** A bot's face by its id: a worker's, in its quiet line and a digest. */
  face(id: string): SpadeAvatar;
}

/**
 * Room above a row: 4px within a run (the person's messages one after another too), 16px between
 * turns, 24px above a time line and 12px under it.
 */
function spaceAbove(row: SpadeChatRow, previous: SpadeChatRow | undefined): string {
  if (!previous) return "";
  if (row.kind === "time") return "mt-6";
  if (previous.kind === "time") return "mt-3";
  if (row.kind === "run") return "mt-(--chat-turn-gap)";
  switch (row.item.kind) {
    case "person":
      return previous.kind === "item" && previous.item.kind === "person"
        ? "mt-(--chat-run-gap)"
        : "mt-(--chat-turn-gap)";
    case "helper":
    case "quiet":
      // A helper line reads under the reply that started it; quiet lines
      // stack under the words they follow.
      return previous.kind === "run" ||
        previous.item.kind === "helper" ||
        previous.item.kind === "quiet"
        ? "mt-1"
        : "mt-(--chat-turn-gap)";
    default:
      return "mt-(--chat-turn-gap)";
  }
}

const Row = memo(function Row(props: {
  row: SpadeChatRow;
  previous: SpadeChatRow | undefined;
  bot: ChatBot;
  handlers: Handlers;
}) {
  const { row, bot } = props;
  const space = spaceAbove(row, props.previous);
  if (row.kind === "time")
    return (
      <div
        role="separator"
        aria-label={row.routine ? `${row.routine} · ${row.label}` : row.label}
        className={cn("text-center text-xs leading-4 text-subtle-foreground tabular-nums", space)}
      >
        {row.routine && (
          <>
            <span className="font-medium text-muted-foreground">{row.routine}</span>
            {" · "}
          </>
        )}
        {row.label}
      </div>
    );
  if (row.kind === "run") {
    const other = row.sender.kind === "other" ? row.sender.agent : undefined;
    return (
      <div
        role="article"
        aria-label={other ? other.name : bot.name}
        className={cn("flex min-w-0 flex-col items-start gap-(--chat-run-gap)", space)}
      >
        {other && (
          <SpeakerLine
            avatar={bot.others.get(other.id) ?? parseSpadeAvatar(undefined, other.id)}
            name={other.name}
          />
        )}
        {row.items.map((item, index) => (
          <RunItem
            key={item.key}
            item={item}
            when={row.whens[index]}
            bot={bot}
            handlers={props.handlers}
          />
        ))}
      </div>
    );
  }
  return <Single item={row.item} when={row.when} space={space} handlers={props.handlers} />;
});

/** Who wrote a bubble of the bot's, for its `spade-message` variant: Spade itself or a bot. */
const sender = (bot: ChatBot) => (bot.avatar.kind === "spade" ? "spade" : "bot");

/** One of a run's bubbles: the bot's words, its files, a card, a request, a skill or its steps. */
function RunItem(props: {
  item: SpadeChatItem;
  when: string | undefined;
  bot: ChatBot;
  handlers: Handlers;
}) {
  const { item, bot, handlers } = props;
  switch (item.kind) {
    case "bot": {
      const words = Boolean(item.text || item.end);
      // Finished words only: a reply still being written isn't copied or read yet.
      const said = item.text && !item.live ? item.text : undefined;
      const media = (
        <>
          {item.images.length > 0 && <Pictures images={item.images} side="bot" />}
          {item.documents.length > 0 && <DocumentChips documents={item.documents} side="bot" />}
        </>
      );
      return (
        <div className="flex w-full min-w-0 flex-col items-start gap-(--chat-run-gap)">
          {words ? (
            <BubbleFrame
              side="bot"
              when={props.when}
              copy={said && spadePlainText(said)}
              speak={said}
            >
              <div
                {...part(
                  "spade-message",
                  item.live ? "working" : item.end === "failed" && "failed",
                  sender(bot),
                )}
                className={cn(chatBubble, framed)}
              >
                {item.text && <SpadeBubbleText text={item.text} />}
                {item.end === "failed" && item.failure ? (
                  <Failure
                    failure={item.failure}
                    endpoint={
                      item.failure.endpoint && handlers.endpointName?.(item.failure.endpoint)
                    }
                    spaced={Boolean(item.text)}
                    onRetry={handlers.onRetry}
                  />
                ) : (
                  item.end && (
                    <p className={cn("text-ui text-muted-foreground", item.text && "mt-1")}>
                      {item.end === "stopped"
                        ? "Stopped"
                        : item.end === "failed"
                          ? "Couldn't finish"
                          : "Interrupted"}
                    </p>
                  )
                )}
              </div>
            </BubbleFrame>
          ) : (
            media
          )}
          {/* What its tools showed the person, after its words (ADR 0134). */}
          {words && media}
          {item.files && <FileChips paths={item.files} onOpen={handlers.onOpenFile} />}
        </div>
      );
    }
    case "other":
      return (
        <BubbleFrame
          side="bot"
          when={props.when}
          copy={spadePlainText(item.text)}
          speak={item.text}
        >
          <div {...part("spade-message", undefined, "other")} className={cn(chatBubble, framed)}>
            <SpadeBubbleText text={item.text} />
          </div>
        </BubbleFrame>
      );
    case "steps":
      return <SpadeStepsLine summary={item.summary} steps={item.steps} />;
    case "files":
      return (
        <div {...part("spade-message", undefined, sender(bot))} className={chatBubble}>
          <FileChips paths={item.paths} onOpen={handlers.onOpenFile} first />
        </div>
      );
    case "question":
      return <SpadeQuestionBubble item={item} botName={bot.name} onReply={handlers.onQuestion} />;
    case "ask":
      return (
        <SpadeRequestBubble
          item={item}
          botId={bot.id}
          botName={bot.name}
          nameOf={(id) => bot.names.get(id)}
          onAnswer={handlers.onAnswer}
        />
      );
    case "plugin-outside": {
      const answer = handlers.onAnswerOutside;
      return (
        <SpadeOutsideBubble
          item={item}
          onAnswer={(id, choice) => (answer ? answer(id, choice) : Promise.resolve(false))}
        />
      );
    }
    case "digest":
      return <SpadeDigestBubble digest={item.digest} when={props.when} face={handlers.face} />;
    case "skill": {
      const answer = handlers.onProposal;
      return (
        <SkillProposal
          proposal={item.proposal}
          botName={bot.name}
          className={chatBubble}
          onAnswer={(save) => (answer ? answer(item.proposal.id, save) : Promise.resolve(false))}
        />
      );
    }
    default:
      return null;
  }
}

/** A row of its own: the person's message, a routine's or group's label, a quiet line. */
function Single(props: {
  item: SpadeChatItem;
  when: string | undefined;
  space: string;
  handlers: Handlers;
}) {
  const { item, space } = props;
  switch (item.kind) {
    case "person":
      return (
        <div
          role="article"
          aria-label="You"
          aria-busy={item.sending || undefined}
          className={cn(
            "flex flex-col items-end gap-(--chat-run-gap)",
            item.sending && "opacity-70",
            space,
          )}
        >
          {item.images.length > 0 && <Pictures images={item.images} side="person" />}
          {item.documents.length > 0 && <DocumentChips documents={item.documents} side="person" />}
          {item.text && (
            <BubbleFrame
              side="mine"
              when={props.when}
              copy={spadePlainText(item.text)}
              speak={undefined}
            >
              <div {...part("spade-message", undefined, "user")} className={cn(mineBubble, framed)}>
                <SpadeBubbleText text={item.text} side="mine" />
                {/* A voice message: its transcript, and the recording to play. */}
                {item.voice && (
                  <div className="-mx-2 mt-0.5 -mb-1 flex">
                    <VoicePlay voice={item.voice} />
                  </div>
                )}
              </div>
            </BubbleFrame>
          )}
        </div>
      );
    case "task-paused":
      return (
        <p role="note" className={cn("text-xs text-muted-foreground", space)}>
          {item.text}
        </p>
      );
    case "group":
      // A group the bot is in sent it (ADR 0132): a small label, then what was asked, quietly.
      return (
        <div
          role="note"
          aria-label={`In ${item.group}`}
          className={cn("flex flex-col items-center gap-1", space)}
        >
          <span className="rounded-full bg-chat-bubble px-2.5 py-0.5 text-xs text-muted-foreground">
            {item.agent ? `In ${item.group} · ${item.agent.name}` : `In ${item.group}`}
          </span>
          {item.text && (
            <p className="max-w-[80%] text-center text-xs text-muted-foreground wrap-anywhere line-clamp-3">
              {item.text}
            </p>
          )}
        </div>
      );
    case "handback":
      // The person handed the computer back: Spade's narration as one quiet line, and the names
      // it involved (files, addresses) as plain text behind a disclosure, never as links.
      return (
        <div role="note" className={cn("flex flex-col items-center gap-1 text-center", space)}>
          <p className="max-w-[80%] text-xs text-muted-foreground wrap-anywhere">{item.text}</p>
          {item.data.length > 0 && (
            <Disclosure
              summary="What changed"
              summaryClassName="text-xs"
              className="flex max-w-[80%] flex-col items-center"
            >
              <ul
                aria-label="What changed"
                className="mt-1 flex flex-col gap-0.5 font-mono text-xs text-muted-foreground wrap-anywhere"
              >
                {item.data.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      );
    case "quiet": {
      const { onOpenBot, onOpenWork } = props.handlers;
      const quiet = item.quiet;
      // A bot worker's line opens its chat, a goal's or a check's opens Work; an ace worker's
      // is a note where it happened.
      const worker =
        (quiet.kind === "worker-started" || quiet.kind === "worker-reported") && !quiet.ace
          ? quiet.worker
          : undefined;
      const onOpen =
        quiet.kind === "goal" || quiet.kind === "checked"
          ? onOpenWork
          : worker && onOpenBot
            ? () => onOpenBot(worker)
            : undefined;
      return (
        <div className={cn("flex", space)}>
          <QuietLine line={spadeQuietLine(quiet)} face={props.handlers.face} onOpen={onOpen} />
        </div>
      );
    }
    case "helper": {
      return (
        <div className={space}>
          <SpadeHelperLine text={item.text} open={item.open} since={item.at} />
        </div>
      );
    }
    default:
      return null;
  }
}
