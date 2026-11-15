import {
  spadeAnswerWords,
  spadeCardAnswers,
  spadeEmptyDraft,
  type SpadeBubble,
  type SpadeDraft,
} from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import type { QuestionReply } from "./use-spade-conversation.ts";
import { QuestionInputs } from "./spade-question-inputs.tsx";

type Card = Extract<SpadeBubble, { kind: "question" }>;

/** Where a card's element is, for "N questions for later" to scroll to. */
export const questionAnchor = (callId: string) => `[data-question="${CSS.escape(callId)}"]`;

/**
 * A card of questions the bot asks (ADR 0154), as its bubble where it asked: each question in
 * order with its inputs, then Send, Answer later and Never mind. Left for later it says so and
 * keeps its inputs, to be answered any time. Answered, the answers stand in place of the inputs;
 * dismissed or closed, one quiet word says so. A refusal (a rule a draft broke, or a card no
 * longer open) reads under the questions in Spade's words.
 */
export function SpadeQuestionBubble(props: {
  item: Card;
  botName: string;
  className: string;
  /** Resolves with undefined once sent, else what to say under the card ("" for nothing). */
  onReply(callId: string, reply: QuestionReply): Promise<string | undefined>;
}) {
  const { item } = props;
  const { questions } = item;
  const open = item.standing === "waiting" || item.standing === "deferred";
  const [drafts, setDrafts] = useState<SpadeDraft[]>(() => questions.map(spadeEmptyDraft));
  const [sending, setSending] = useState<"send" | "defer" | "dismiss">();
  const [problem, setProblem] = useState<string>();
  const lone = questions.length === 1 ? questions[0] : undefined;
  // A lone yes-or-no question is answered by Yes or No themselves.
  const loneConfirm = lone?.kind === "confirm";
  const reply = (what: "send" | "defer" | "dismiss", body: QuestionReply) => {
    setSending(what);
    setProblem(undefined);
    void props.onReply(item.callId, body).then((said) => {
      setSending(undefined);
      if (said) setProblem(said);
    });
  };
  const send = (next = drafts) => {
    if (sending) return;
    const read = spadeCardAnswers(questions, next);
    if ("missing" in read) {
      const prompt = questions[read.at]?.prompt;
      setProblem(
        questions.length > 1 && prompt ? `${prompt} ${read.missing}.` : `${read.missing}.`,
      );
      return;
    }
    reply("send", { answers: read.answers });
  };
  const draft = (at: number) => (next: SpadeDraft) => {
    const all = drafts.with(at, next);
    setDrafts(all);
    setProblem(undefined);
    if (loneConfirm && next.kind === "confirm") send(all);
  };
  return (
    <div
      role="group"
      aria-label={
        lone
          ? `${props.botName} asks: ${lone.prompt}`
          : `${props.botName} asks ${questions.length} questions`
      }
      data-question={item.callId}
      // Reached by "questions for later", which moves focus here.
      tabIndex={-1}
      onKeyDown={(event) => {
        if (open && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          send();
        }
      }}
      className={cn(props.className, "focus-ring")}
    >
      {item.standing === "deferred" && (
        <p className="mb-1 text-ui text-muted-foreground">For later</p>
      )}
      <ol className="flex flex-col gap-3">
        {questions.map((question, at) => (
          // Questions keep their place in the card; the bot gives no other identity.
          // eslint-disable-next-line react/no-array-index-key
          <li key={at} className="min-w-0">
            <p className="whitespace-pre-wrap">{question.prompt}</p>
            {open ? (
              <QuestionInputs
                question={question}
                draft={drafts[at] ?? spadeEmptyDraft(question)}
                onDraft={draft(at)}
                onSubmit={() => send()}
                disabled={sending !== undefined}
              />
            ) : (
              item.answers?.[at] !== undefined && (
                <p className="mt-0.5 text-ui text-muted-foreground wrap-anywhere">
                  {spadeAnswerWords(question, item.answers[at])}
                </p>
              )
            )}
          </li>
        ))}
      </ol>
      {problem && (
        <p role="alert" className="mt-2 text-ui text-destructive">
          {problem}
        </p>
      )}
      <div className="-mx-2 mt-1.5 -mb-1 flex flex-wrap items-center gap-1">
        {open ? (
          <>
            {!loneConfirm && (
              <Button
                size="xs"
                variant="ghost"
                disabled={sending !== undefined}
                onClick={() => send()}
              >
                {sending === "send" ? "Sending…" : "Send"}
              </Button>
            )}
            {item.standing === "waiting" && (
              <Button
                size="xs"
                variant="ghost"
                disabled={sending !== undefined}
                onClick={() => reply("defer", { defer: true })}
              >
                Answer later
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              disabled={sending !== undefined}
              onClick={() => reply("dismiss", { dismiss: true })}
            >
              Never mind
            </Button>
          </>
        ) : (
          <span className="px-2 text-ui text-muted-foreground">{settled(item)}</span>
        )}
      </div>
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
