import {
  spadeAnswerWords,
  spadeCardAnswers,
  spadeCardSettledWords,
  spadeDraftAnswer,
  spadeEmptyDraft,
  spadeRefusedQuestion,
  type SpadeBubble,
  type SpadeDraft,
} from "@ace/ui-core/spade-chat";
import { Fragment, useRef, useState } from "react";
import { QuestionPager } from "@/components/question-pager.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { cn } from "@/lib/cn.ts";
import { useCardFocus } from "./use-card-focus.ts";
import type { QuestionReply } from "./use-spade-conversation.ts";
import { QuestionInputs } from "./spade-question-inputs.tsx";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import {
  botBubble,
  CardBody,
  cardKeyHint,
  CardFooter,
  CardPrimary,
  CardSecondary,
  CardWord,
  LaterClock,
  NeedsYouLine,
  personBubble,
  RaisedCard,
  settledLine,
} from "./spade-card.tsx";

type Card = Extract<SpadeBubble, { kind: "question" }>;

/** Where a card's element is, for "N questions for later" to scroll to. */
export const questionAnchor = (callId: string) => `[data-question="${CSS.escape(callId)}"]`;

/**
 * A card of questions the bot asks (ADR 0154), where it asked. Waiting on the person it is
 * raised: one question at a time (‹ 1/2 › between them, answers kept across them), Answer later
 * and Never mind on the left, and Next, or Send on the last, on the right. Left for later it
 * folds to one line with Answer, which opens it again (Answer later folds it back); so does
 * reaching it from "questions for later". Answered, dismissed or closed, it settles flat into a bubble with the answers in it. A
 * refusal (a rule a draft broke, or a card no longer open) reads under the question it names.
 */
export function SpadeQuestionBubble(props: {
  item: Card;
  botName: string;
  /** Resolves with undefined once sent, else what to say under the card ("" for nothing). */
  onReply(callId: string, reply: QuestionReply): Promise<string | undefined>;
}) {
  const { item } = props;
  const [opened, setOpened] = useState(false);
  const lone = item.questions.length === 1 ? item.questions[0] : undefined;
  const label = lone
    ? `${props.botName} asks: ${lone.prompt}`
    : `${props.botName} asks ${item.questions.length} questions`;
  if (item.standing === "deferred" && !opened)
    return (
      <div
        role="group"
        aria-label={label}
        data-question={item.callId}
        // Reached by "questions for later", which moves focus here: that opens it.
        tabIndex={-1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setOpened(true);
        }}
        className={cn(settledLine, "items-center rounded-sm focus-ring")}
      >
        <LaterClock />
        <span className="min-w-0 truncate">
          {`For later · ${lone ? lone.prompt : `${item.questions.length} questions`}`}
        </span>
        <button
          type="button"
          onClick={() => setOpened(true)}
          className="-mx-1 shrink-0 touch-hit rounded-sm px-1 font-medium text-foreground focus-ring hover:underline"
        >
          Answer
        </button>
      </div>
    );
  if (item.standing === "waiting" || item.standing === "deferred")
    return (
      <OpenCard
        item={item}
        label={label}
        // Opened again from its line, Answer later folds it back; it is for later already.
        onFold={item.standing === "deferred" ? () => setOpened(false) : undefined}
        onReply={props.onReply}
      />
    );
  return <SettledCard item={item} label={label} />;
}

function OpenCard(props: {
  item: Card;
  label: string;
  /** Fold it back to its line (a card already for later). */
  onFold: (() => void) | undefined;
  onReply(callId: string, reply: QuestionReply): Promise<string | undefined>;
}) {
  const { item } = props;
  const { questions } = item;
  const count = questions.length;
  const [drafts, setDrafts] = useState<SpadeDraft[]>(() => questions.map(spadeEmptyDraft));
  const [page, setPage] = useState(0);
  const [sending, setSending] = useState<"send" | "defer" | "dismiss">();
  const [problem, setProblem] = useState<string>();
  const at = Math.min(page, count - 1);
  const current = questions[at];
  const last = at === count - 1;
  // A lone yes-or-no question is answered by Yes or No themselves.
  const loneConfirm = count === 1 && current?.kind === "confirm";
  const draftOf = (index: number) => {
    const question = questions[index];
    return drafts[index] ?? (question ? spadeEmptyDraft(question) : undefined);
  };
  const answered = (index: number) => {
    const question = questions[index];
    const draft = draftOf(index);
    return (
      question !== undefined && draft !== undefined && "answer" in spadeDraftAnswer(question, draft)
    );
  };
  const reply = (what: "send" | "defer" | "dismiss", body: QuestionReply) => {
    setSending(what);
    setProblem(undefined);
    void props.onReply(item.callId, body).then((said) => {
      setSending(undefined);
      if (!said) return;
      setProblem(said);
      // Spade names the question it refused: show that one.
      const named = spadeRefusedQuestion(said, count);
      if (named !== undefined) setPage(named);
    });
  };
  // The card turns to the question that needs more, so the reason needs no prompt of its own.
  const miss = (index: number, missing: string) => {
    setPage(index);
    setProblem(`${missing}.`);
  };
  const send = (next = drafts) => {
    if (sending) return;
    const read = spadeCardAnswers(questions, next);
    if ("missing" in read) return miss(read.at, read.missing);
    reply("send", { answers: read.answers });
  };
  // Next until the last question, then Send.
  const advance = () => {
    if (last) return send();
    const question = questions[at];
    const draft = draftOf(at);
    if (!question || !draft) return;
    const read = spadeDraftAnswer(question, draft);
    if ("missing" in read) return miss(at, read.missing);
    setProblem(undefined);
    setPage(at + 1);
  };
  const draft = (next: SpadeDraft) => {
    const all = drafts.with(at, next);
    setDrafts(all);
    setProblem(undefined);
    if (loneConfirm && next.kind === "confirm") send(all);
  };
  const card = useRef<HTMLDivElement>(null);
  useCardFocus(card, at);
  if (!current) return null;
  return (
    <RaisedCard
      asks="question"
      ref={card}
      role="group"
      aria-label={props.label}
      data-question={item.callId}
      // Reached by "questions for later", which moves focus here.
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          send();
        }
      }}
    >
      <NeedsYouLine
        glyph="question"
        aside={
          count > 1 && (
            <QuestionPager
              index={at}
              count={count}
              canNext={answered(at)}
              onGo={(to) => {
                setProblem(undefined);
                setPage(to);
              }}
            />
          )
        }
      >
        <SpadeBubbleText text={current.prompt} />
      </NeedsYouLine>
      {(!loneConfirm || problem) && (
        <CardBody>
          {!loneConfirm && (
            <QuestionInputs
              // One question's inputs at a time; its draft stays with the card.
              key={at}
              question={current}
              draft={draftOf(at) ?? spadeEmptyDraft(current)}
              onDraft={draft}
              onSubmit={advance}
              disabled={sending !== undefined}
              refused={problem !== undefined}
            />
          )}
          {problem && (
            <p role="alert" className="text-xs leading-4 text-destructive">
              {problem}
            </p>
          )}
        </CardBody>
      )}
      <CardFooter
        start={
          <>
            {(item.standing === "waiting" || props.onFold) && (
              <CardWord
                disabled={sending !== undefined}
                onClick={() => (props.onFold ? props.onFold() : reply("defer", { defer: true }))}
              >
                Answer later
              </CardWord>
            )}
            <CardWord
              disabled={sending !== undefined}
              onClick={() => reply("dismiss", { dismiss: true })}
            >
              Never mind
            </CardWord>
          </>
        }
        end={
          loneConfirm ? (
            <>
              <CardSecondary
                disabled={sending !== undefined}
                onClick={() => draft({ kind: "confirm", value: false })}
              >
                No
              </CardSecondary>
              <CardPrimary
                disabled={sending !== undefined}
                onClick={() => draft({ kind: "confirm", value: true })}
              >
                Yes
              </CardPrimary>
            </>
          ) : last ? (
            <CardPrimary disabled={sending !== undefined} onClick={() => send()}>
              {sending === "send" ? "Sending…" : "Send"}
              <Kbd
                aria-hidden
                keys="mod+enter"
                resolve={false}
                variant="on-primary"
                className={cardKeyHint}
              />
            </CardPrimary>
          ) : (
            <CardPrimary onClick={advance}>Next</CardPrimary>
          )
        }
      />
    </RaisedCard>
  );
}

/**
 * Settled: each question as a quiet bubble of the bot's and its answer as the person's own
 * bubble, in the accent. Unanswered (dismissed, closed, or answered by typing in the chat), the
 * questions keep their bubble and one quiet line says how it ended.
 */
function SettledCard(props: { item: Card; label: string }) {
  const { item } = props;
  const answers = item.standing === "answered" ? item.answers : undefined;
  return (
    <div
      role="group"
      aria-label={props.label}
      data-question={item.callId}
      tabIndex={-1}
      className="flex w-full min-w-0 flex-col items-start gap-(--chat-run-gap) rounded-lg focus-ring"
    >
      {answers ? (
        item.questions.map((question, at) => {
          const answer = answers[at];
          return (
            // Questions keep their place in the card; the bot gives no other identity.
            // eslint-disable-next-line react/no-array-index-key
            <Fragment key={at}>
              <div
                className={cn(
                  botBubble,
                  "text-muted-foreground",
                  at > 0 && "mt-[calc(var(--chat-turn-gap)-var(--chat-run-gap))]",
                )}
              >
                <SpadeBubbleText text={question.prompt} />
              </div>
              {answer !== undefined && (
                <div
                  role="article"
                  aria-label="You"
                  className={cn(personBubble, "self-end whitespace-pre-wrap")}
                >
                  {spadeAnswerWords(question, answer)}
                </div>
              )}
            </Fragment>
          );
        })
      ) : (
        <>
          <div className={cn(botBubble, "flex flex-col gap-2.5 text-muted-foreground")}>
            {item.questions.map((question, at) => (
              // eslint-disable-next-line react/no-array-index-key
              <SpadeBubbleText key={at} text={question.prompt} />
            ))}
          </div>
          <p className={cn(settledLine, "mt-1 text-subtle-foreground")}>
            {spadeCardSettledWords(item)}
          </p>
        </>
      )}
    </div>
  );
}
