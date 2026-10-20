import type { Question } from "@ace/protocol";
import { questionOptions } from "@ace/ui-core";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import type { Answer } from "./answer.ts";
import { draftAnswers, isAnswered, otherAnswer, type QuestionDraft } from "./question-draft.ts";
import { questionDrafts, useQuestionDraft } from "./question-drafts.ts";
import { QuestionField } from "./question-field.tsx";

/**
 * An agent's questions, one at a time (`QuestionField`). The footer has "‹ 1/3 ›" on the left
 * to move between the questions, and Skip and Continue on the right: Continue goes to the next
 * question, and on the last sends every answer. Skip asks for an optional note to the agent in
 * the footer's place, Escape going back. 1–9 pick an option and Enter continues, unless a text
 * field has the keys. What is picked and typed lives in the card's draft, which a reply from
 * the composer reads too.
 */
export function QuestionForm(props: {
  interactionId: string;
  /** Who asks, for the note's placeholder. */
  asker: string;
  /** At the start of the question's first line (its header, else its text). */
  lead?: ReactNode;
  /** At the end of that line: the strip's pager and indicators. */
  aside?: ReactNode;
  questions: readonly Question[];
  disabled: boolean;
  onAnswer: Answer;
}) {
  const draft = useQuestionDraft(props.interactionId);
  const edit = (change: (draft: QuestionDraft) => QuestionDraft) =>
    questionDrafts.update(props.interactionId, change);
  const { picked, texts } = draft;
  const count = props.questions.length;
  const index = Math.min(draft.at, count - 1);
  const current = props.questions[index];
  const last = index === count - 1;
  const answered = (question: Question | undefined) => isAnswered(question, draft);
  const complete = props.questions.every(answered);
  const ready = !props.disabled && answered(current) && (!last || complete);
  const go = (at: number) => edit((before) => ({ ...before, at }));
  const advance = () => {
    if (!ready) return;
    if (last) props.onAnswer({ kind: "question", answers: draftAnswers(props.questions, draft) });
    else go(index + 1);
  };
  const toggle = (question: Question, id: string) =>
    edit((before) => {
      const was = before.picked[question.id] ?? [];
      const next = question.multiSelect
        ? was.includes(id)
          ? was.filter((value) => value !== id)
          : [...was, id]
        : [id];
      return { ...before, picked: { ...before.picked, [question.id]: next } };
    });
  /** Typing in the free answer picks it; emptying it doesn't unpick, so the row stays put. */
  const type = (question: Question, text: string) => {
    edit((before) => ({ ...before, texts: { ...before.texts, [question.id]: text } }));
    if (text && !(picked[question.id] ?? []).includes(otherAnswer)) toggle(question, otherAnswer);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (props.disabled || event.metaKey || event.ctrlKey || event.altKey || !current) return;
    const target = event.target as HTMLElement;
    const text =
      target.tagName === "TEXTAREA" ||
      (target.tagName === "INPUT" &&
        !["radio", "checkbox"].includes((target as HTMLInputElement).type));
    // Enter continues from a field or a focused option, never from another button.
    const onOption = ["radio", "checkbox"].includes(target.getAttribute("role") ?? "");
    if (event.key === "Enter" && (target.tagName !== "BUTTON" || onOption)) {
      event.preventDefault();
      advance();
      return;
    }
    const digit = Number.parseInt(event.key, 10);
    if (text || Number.isNaN(digit) || digit < 1) return;
    const ids = [
      ...questionOptions(current).map((option) => option.id),
      ...(current.allowOther ? [otherAnswer] : []),
    ];
    const id = ids[digit - 1];
    if (!id) return;
    event.preventDefault();
    toggle(current, id);
  };
  const [skipping, setSkipping] = useState(false);
  const skip = useRef<HTMLButtonElement>(null);
  if (!current) return null;
  return (
    <form
      className="mt-1 flex flex-col gap-3"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        advance();
      }}
    >
      <QuestionField
        key={current.id}
        question={current}
        picked={picked[current.id] ?? []}
        text={texts[current.id] ?? ""}
        lead={props.lead}
        aside={props.aside}
        disabled={props.disabled}
        onToggle={(id) => toggle(current, id)}
        onText={(text) => type(current, text)}
      />
      {skipping ? (
        <SkipNote
          asker={props.asker}
          disabled={props.disabled}
          onSkip={(note) =>
            props.onAnswer({
              kind: "question",
              answers: {},
              dismissed: true,
              ...(note ? { feedback: note } : {}),
            })
          }
          onCancel={() => {
            setSkipping(false);
            // Back where the person was: the Skip that opened the note.
            requestAnimationFrame(() => skip.current?.focus());
          }}
        />
      ) : (
        <div className="flex items-center gap-2">
          {count > 1 && (
            <span className="flex items-center gap-0.5 text-xs text-subtle-foreground tabular-nums">
              <IconButton
                size="sm"
                icon={CaretLeftIcon}
                label="Previous question"
                disabled={index === 0}
                onClick={() => go(index - 1)}
              />
              <span aria-label={`Question ${index + 1} of ${count}`}>
                {index + 1}/{count}
              </span>
              <IconButton
                size="sm"
                icon={CaretRightIcon}
                label="Next question"
                disabled={last || !answered(current)}
                onClick={() => go(index + 1)}
              />
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <Button
              ref={skip}
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.disabled}
              onClick={() => setSkipping(true)}
            >
              Skip
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!ready}
              title={
                ready ? undefined : last && !complete ? "Answer every question" : "Pick an answer"
              }
            >
              Continue
            </Button>
          </span>
        </div>
      )}
    </form>
  );
}

/**
 * Skipping, in the footer's place: an optional note to the agent and the Skip that sends it.
 * Enter skips; Escape goes back to the question (the strip leaves it to this field).
 */
function SkipNote(props: {
  asker: string;
  disabled: boolean;
  onSkip(note: string | undefined): void;
  onCancel(): void;
}) {
  const [note, setNote] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const send = () => props.onSkip(note.trim() || undefined);
  return (
    <div data-own-escape="" className="flex items-center gap-2">
      <Input
        ref={field}
        aria-label={`Note for ${props.asker}`}
        placeholder={`Note for ${props.asker} (optional)`}
        value={note}
        maxLength={8192}
        disabled={props.disabled}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Enter") send();
          else props.onCancel();
        }}
        className="flex-1"
      />
      <Button type="button" size="sm" variant="primary" disabled={props.disabled} onClick={send}>
        Skip
      </Button>
    </div>
  );
}
