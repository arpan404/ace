import {
  spadeAnswerWords,
  spadeCardAnswers,
  spadeDraftAnswer,
  spadeEmptyDraft,
  spadeRefusedQuestion,
  type SpadeBubble,
  type SpadeDraft,
} from "@ace/ui-core/spade-chat";
import { useEffect, useRef, useState } from "react";
import { QuestionPager } from "@/components/question-pager.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { cn } from "@/lib/cn.ts";
import type { QuestionReply } from "./use-spade-conversation.ts";
import { QuestionInputs } from "./spade-question-inputs.tsx";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import { CardFooter, NeedsYouLine, quietBubble, RaisedCard } from "./spade-card.tsx";

type Card = Extract<SpadeBubble, { kind: "question" }>;

/** Where a card's element is, for "N questions for later" to scroll to. */
export const questionAnchor = (callId: string) => `[data-question="${CSS.escape(callId)}"]`;

/**
 * A card of questions the bot asks (ADR 0154), where it asked. Waiting on the person it is
 * raised: one question at a time (‹ 1/2 › between them, answers kept across them), Answer later
 * and Never mind on the left, and Next, or Send on the last, on the right. Left for later it
 * folds to one line with Answer, which opens it again; so does reaching it from "questions for
 * later". Answered, dismissed or closed, it settles flat into a bubble with the answers in it. A
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
        className={cn(quietBubble, "flex items-center gap-3 focus-ring")}
      >
        <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
          {`For later · ${lone ? lone.prompt : `${item.questions.length} questions`}`}
        </span>
        <Button
          size="xs"
          variant="ghost"
          className="-my-1 -mr-1.5 text-foreground"
          onClick={() => setOpened(true)}
        >
          Answer
        </Button>
      </div>
    );
  if (item.standing === "waiting" || item.standing === "deferred")
    return <OpenCard item={item} label={label} focus={opened} onReply={props.onReply} />;
  return <SettledCard item={item} label={label} />;
}

function OpenCard(props: {
  item: Card;
  label: string;
  /** Opened again from its folded line: focus moves into it, its inputs ready. */
  focus: boolean;
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
  const miss = (index: number, missing: string) => {
    const prompt = questions[index]?.prompt;
    setPage(index);
    setProblem(count > 1 && prompt ? `${prompt} ${missing}.` : `${missing}.`);
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
  const focus = props.focus;
  useEffect(() => {
    if (focus) card.current?.focus({ preventScroll: true });
  }, [focus]);
  if (!current) return null;
  return (
    <RaisedCard
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
      <QuestionInputs
        // One question's inputs at a time; its draft stays with the card.
        key={at}
        question={current}
        draft={draftOf(at) ?? spadeEmptyDraft(current)}
        onDraft={draft}
        onSubmit={advance}
        disabled={sending !== undefined}
      />
      {problem && (
        <p role="alert" className="mt-3 text-ui text-destructive">
          {problem}
        </p>
      )}
      <CardFooter
        start={
          <>
            {item.standing === "waiting" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={sending !== undefined}
                onClick={() => reply("defer", { defer: true })}
              >
                Answer later
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={sending !== undefined}
              onClick={() => reply("dismiss", { dismiss: true })}
            >
              Never mind
            </Button>
          </>
        }
        end={
          !loneConfirm &&
          (last ? (
            <Button
              size="sm"
              variant="primary"
              disabled={sending !== undefined}
              onClick={() => send()}
            >
              {sending === "send" ? "Sending…" : "Send"}
              <Kbd aria-hidden keys="mod+enter" resolve={false} variant="on-primary" className="ml-1.5" />
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={advance}>
              Next
            </Button>
          ))
        }
      />
    </RaisedCard>
  );
}

/** Settled flat: each prompt over its answer, then one quiet word on how it ended. */
function SettledCard(props: { item: Card; label: string }) {
  const { item } = props;
  return (
    <div
      role="group"
      aria-label={props.label}
      data-question={item.callId}
      tabIndex={-1}
      className={cn(quietBubble, "flex flex-col gap-0.5 focus-ring")}
    >
      {item.questions.map((question, at) => {
        const answer = item.answers?.[at];
        return (
          // Questions keep their place in the card; the bot gives no other identity.
          // eslint-disable-next-line react/no-array-index-key
          <div key={at} className={cn("flex min-w-0 flex-col gap-0.5", at > 0 && "mt-2")}>
            <div className="text-ui text-muted-foreground">
              <SpadeBubbleText text={question.prompt} />
            </div>
            {answer !== undefined && (
              <p className="text-base leading-5 text-foreground wrap-anywhere">
                {spadeAnswerWords(question, answer)}
              </p>
            )}
          </div>
        );
      })}
      <p className="mt-1 text-xs leading-4 text-subtle-foreground">{settled(item)}</p>
    </div>
  );
}

function settled(item: Card): string {
  switch (item.standing) {
    case "answered":
      return item.typed && item.answers === undefined ? "Answered in the chat" : "Answered";
    case "dismissed":
      return "Dismissed";
    default:
      return "Not answered";
  }
}
