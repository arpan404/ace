import type { Question } from "@ace/protocol";
import { questionOptions } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useId, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useComposerMessage, useOfferAnswer } from "../composer/answer-slot.ts";
import type { Answer } from "./answer.ts";

const other = "__other__";

/**
 * One or more questions with options; free text where the agent accepts it. On its own card it
 * has Answer and Skip. Attached to a thread's composer (`composer`, the thread's id) it shows one
 * question at a time ("1 of 2", Back) and the composer answers it: its message is the typed
 * answer ("Something else" puts the caret there), and its send button reads Answer, Submit once
 * an option is picked, or Next while more questions follow. Skip is the card's.
 */
export function QuestionForm(props: {
  questions: readonly Question[];
  disabled: boolean;
  onAnswer: Answer;
  composer?: string | undefined;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [at, setAt] = useState(0);
  const stepped = props.composer !== undefined;
  const index = Math.min(at, props.questions.length - 1);
  const current = props.questions[index];
  const last = index === props.questions.length - 1;
  const shown = stepped ? props.questions.slice(index, index + 1) : props.questions;
  // Attached, the message is the typed answer: typing picks "Something else" for the question shown.
  const message = useComposerMessage(props.composer);
  const typed = stepped && !!message?.typed && !!current?.allowOther;
  const [wasTyped, setWasTyped] = useState(typed);
  if (typed !== wasTyped) {
    setWasTyped(typed);
    if (typed && current && !(picked[current.id] ?? []).includes(other))
      setPicked((previous) => ({
        ...previous,
        [current.id]: current.multiSelect ? [...(previous[current.id] ?? []), other] : [other],
      }));
  }
  const answered = (question: Question | undefined) => {
    const choice = (question && picked[question.id]) ?? [];
    if (!question || choice.length === 0) return false;
    if (!choice.includes(other)) return true;
    return question === current && stepped ? typed : !!texts[question.id]?.trim();
  };
  const complete = props.questions.every(answered);
  const takesText = stepped && (picked[current?.id ?? ""] ?? []).includes(other);
  // Attached: the composer's send button goes on once the question shown is answered.
  const ready = !props.disabled && answered(current) && (!last || complete);
  const submit = (typedText: Record<string, string> = texts) => {
    const answers: Record<string, string[]> = {};
    for (const question of props.questions)
      answers[question.id] = (picked[question.id] ?? []).map((id) =>
        id === other ? (typedText[question.id] ?? "").trim() : id,
      );
    props.onAnswer({ kind: "question", answers });
  };
  /** The message's text answers the question shown when "Something else" is picked. */
  const advance = (text = "") => {
    if (!ready || !current) return;
    const typedText = takesText ? { ...texts, [current.id]: text } : texts;
    if (takesText) setTexts(typedText);
    if (last) submit(typedText);
    else setAt(index + 1);
  };
  useOfferAnswer(
    props.composer,
    stepped && current
      ? {
          label: ready && !last ? "Next" : ready && !takesText ? "Submit" : "Answer",
          blocked: ready
            ? undefined
            : takesText
              ? "Type your answer in the message"
              : current.allowOther
                ? "Pick an answer, or type one in the message"
                : "Pick an answer",
          takesText,
          invitesText: !!current.allowOther,
        }
      : undefined,
    advance,
  );
  const toggle = (question: Question, id: string) =>
    setPicked((previous) => {
      const before = previous[question.id] ?? [];
      const next = question.multiSelect
        ? before.includes(id)
          ? before.filter((value) => value !== id)
          : [...before, id]
        : [id];
      return { ...previous, [question.id]: next };
    });
  /**
   * 1–9 pick an option of the question being answered (the one holding focus, else the first
   * still unanswered) and Enter answers, unless a text field has the keys.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (props.disabled || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    const text =
      target.tagName === "TEXTAREA" ||
      (target.tagName === "INPUT" &&
        !["radio", "checkbox"].includes((target as HTMLInputElement).type));
    if (event.key === "Enter" && !text && target.tagName !== "BUTTON") {
      event.preventDefault();
      if (stepped && !takesText) advance();
      else if (!stepped && complete) submit();
      return;
    }
    const digit = Number.parseInt(event.key, 10);
    if (text || Number.isNaN(digit) || digit < 1) return;
    const focused = target.closest("fieldset")?.getAttribute("data-question");
    const question =
      shown.find((candidate) => candidate.id === focused) ??
      shown.find((candidate) => !(picked[candidate.id] ?? []).length) ??
      shown[0];
    if (!question) return;
    const ids = [
      ...questionOptions(question).map((option) => option.id),
      ...(question.allowOther ? [other] : []),
    ];
    const id = ids[digit - 1];
    if (!id) return;
    event.preventDefault();
    pick(question, id);
  };
  /** Picking "Something else" on the composer's card sends the caret to the message. */
  const pick = (question: Question, id: string) => {
    toggle(question, id);
    if (id === other && stepped) message?.focus();
  };
  return (
    <form
      className="mt-2 flex flex-col gap-4"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        if (stepped && !takesText) advance();
        else if (!stepped && complete) submit();
      }}
    >
      {shown.map((question) => (
        <QuestionField
          key={question.id}
          step={
            stepped && props.questions.length > 1
              ? { at: index, of: props.questions.length, onBack: () => setAt(index - 1) }
              : undefined
          }
          question={question}
          picked={picked[question.id] ?? []}
          text={texts[question.id] ?? ""}
          disabled={props.disabled}
          inline={!stepped}
          onToggle={(id) => pick(question, id)}
          onText={(text) => setTexts((previous) => ({ ...previous, [question.id]: text }))}
        />
      ))}
      {!stepped && (
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" variant="primary" disabled={!complete || props.disabled}>
            Answer
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => props.onAnswer({ kind: "question", answers: {}, dismissed: true })}
          >
            Skip
          </Button>
        </div>
      )}
    </form>
  );
}

function QuestionField(props: {
  /** Where this question is among several shown one at a time. */
  step?: { at: number; of: number; onBack(): void } | undefined;
  question: Question;
  picked: readonly string[];
  text: string;
  disabled: boolean;
  /** "Something else" is typed here, on a card without a composer under it. */
  inline: boolean;
  onToggle(id: string): void;
  onText(text: string): void;
}) {
  const { question } = props;
  const legend = useId();
  const type = question.multiSelect ? "checkbox" : "radio";
  const options = [
    ...questionOptions(question),
    ...(question.allowOther
      ? [{ id: other, label: "Something else", description: undefined, recommended: false }]
      : []),
  ];
  return (
    <fieldset
      aria-labelledby={legend}
      data-question={question.id}
      className="flex flex-col gap-1.5"
    >
      <legend id={legend} className="mb-1.5 text-md leading-[1.35] font-medium tracking-[-0.005em]">
        {(question.header || props.step) && (
          <span className="mb-0.5 flex items-center gap-1.5 text-xs font-normal text-subtle-foreground">
            {props.step && (
              <span className="tabular-nums">
                {props.step.at + 1} of {props.step.of}
              </span>
            )}
            {props.step && question.header && <span aria-hidden>·</span>}
            {question.header}
            {props.step && props.step.at > 0 && (
              <button
                type="button"
                onClick={props.step.onBack}
                className="ml-auto rounded-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-ring"
              >
                Back
              </button>
            )}
          </span>
        )}
        {question.text}
      </legend>
      {options.map((option, index) => {
        const checked = props.picked.includes(option.id);
        return (
          <label
            key={option.id}
            className={cn(
              // The pick reads as a filled row; the one focus ring is the radio's own.
              "flex cursor-pointer items-start gap-2.5 rounded-[10px] bg-muted px-3 py-[9px] text-ui transition-colors duration-(--dur-1) hover:bg-accent",
              checked && "bg-accent",
            )}
          >
            <input
              type={type}
              name={question.id}
              checked={checked}
              disabled={props.disabled}
              onChange={() => props.onToggle(option.id)}
              className="mt-0.5 rounded-full accent-(--ring) focus-ring"
            />
            {/* The option's words, its description under them so a narrow card never wraps
                them into columns. */}
            <span className="min-w-0 flex-1">
              <span className="block">{option.label}</span>
              {option.description && (
                <span className="block text-sm text-subtle-foreground">{option.description}</span>
              )}
            </span>
            {option.recommended && (
              <small className="shrink-0 text-xs text-subtle-foreground">recommended</small>
            )}
            {index < 9 && (
              <kbd aria-hidden className="shrink-0 font-sans text-xs text-subtle-foreground">
                {index + 1}
              </kbd>
            )}
          </label>
        );
      })}
      {props.inline && props.picked.includes(other) && (
        <input
          aria-label={`Your answer to: ${question.text}`}
          value={props.text}
          disabled={props.disabled}
          onChange={(event) => props.onText(event.target.value)}
          className="h-[30px] rounded-md bg-transparent px-2.5 text-ui shadow-[inset_0_0_0_1px_var(--input)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
          placeholder="Type your answer"
        />
      )}
    </fieldset>
  );
}
