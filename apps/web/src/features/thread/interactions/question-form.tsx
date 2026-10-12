import type { Question } from "@ace/protocol";
import { questionOptions } from "@ace/ui-core";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { cn } from "@/lib/cn.ts";
import type { Answer } from "./answer.ts";

const other = "__other__";

/**
 * An agent's questions, one at a time: radio options (checkboxes where several may be picked),
 * and, where the agent takes free text, a last "Something else…" row that is itself the field
 * to type in. The footer has "‹ 1/3 ›" on the left to move between the questions, and Skip and
 * Continue on the right: Continue goes to the next question, and on the last sends every answer.
 * 1–9 pick an option and Enter continues, unless a text field has the keys.
 */
export function QuestionForm(props: {
  questions: readonly Question[];
  disabled: boolean;
  onAnswer: Answer;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [at, setAt] = useState(0);
  const count = props.questions.length;
  const index = Math.min(at, count - 1);
  const current = props.questions[index];
  const last = index === count - 1;
  const answered = (question: Question | undefined) => {
    const choice = (question && picked[question.id]) ?? [];
    if (!question || choice.length === 0) return false;
    return !choice.includes(other) || !!texts[question.id]?.trim();
  };
  const complete = props.questions.every(answered);
  const ready = !props.disabled && answered(current) && (!last || complete);
  const submit = () => {
    const answers: Record<string, string[]> = {};
    for (const question of props.questions)
      answers[question.id] = (picked[question.id] ?? []).map((id) =>
        id === other ? (texts[question.id] ?? "").trim() : id,
      );
    props.onAnswer({ kind: "question", answers });
  };
  const advance = () => {
    if (!ready) return;
    if (last) submit();
    else setAt(index + 1);
  };
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
  /** Typing in "Something else…" picks it; emptying it doesn't unpick, so the row stays put. */
  const type = (question: Question, text: string) => {
    setTexts((previous) => ({ ...previous, [question.id]: text }));
    if (text && !(picked[question.id] ?? []).includes(other)) toggle(question, other);
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
      ...(current.allowOther ? [other] : []),
    ];
    const id = ids[digit - 1];
    if (!id) return;
    event.preventDefault();
    toggle(current, id);
  };
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
        disabled={props.disabled}
        onToggle={(id) => toggle(current, id)}
        onText={(text) => type(current, text)}
      />
      <div className="flex items-center gap-2">
        {count > 1 && (
          <span className="flex items-center gap-0.5 text-xs text-subtle-foreground tabular-nums">
            <IconButton
              size="sm"
              icon={CaretLeftIcon}
              label="Previous question"
              disabled={index === 0}
              onClick={() => setAt(index - 1)}
            />
            <span aria-label={`Question ${index + 1} of ${count}`}>
              {index + 1}/{count}
            </span>
            <IconButton
              size="sm"
              icon={CaretRightIcon}
              label="Next question"
              disabled={last || !answered(current)}
              onClick={() => setAt(index + 1)}
            />
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => props.onAnswer({ kind: "question", answers: {}, dismissed: true })}
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
    </form>
  );
}

function QuestionField(props: {
  question: Question;
  picked: readonly string[];
  text: string;
  disabled: boolean;
  onToggle(id: string): void;
  onText(text: string): void;
}) {
  const { question } = props;
  const legend = useId();
  const field = useRef<HTMLInputElement>(null);
  const options = questionOptions(question);
  /** An option's control; the free answer's names itself, having no label around it. */
  const control = (id: string, label?: string) =>
    question.multiSelect ? (
      <Checkbox
        aria-label={label}
        checked={props.picked.includes(id)}
        disabled={props.disabled}
        onCheckedChange={() => props.onToggle(id)}
        className="mt-0.5"
      />
    ) : (
      <RadioGroupItem aria-label={label} value={id} disabled={props.disabled} className="mt-0.5" />
    );
  const rows = options.map((option, index) => (
    <label
      key={option.id}
      className={cn(
        "flex min-h-8 cursor-pointer items-start gap-2.5 rounded-sm px-1.5 py-1.5 text-ui hover:bg-accent/50",
        props.picked.includes(option.id) ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span className="relative shrink-0">{control(option.id)}</span>
      <span className="min-w-0 flex-1">
        <span className="block">
          {option.label}
          {option.recommended && (
            <small className="ml-2 text-xs text-subtle-foreground">Recommended</small>
          )}
        </span>
        {option.description && (
          <span className="block text-xs text-subtle-foreground">{option.description}</span>
        )}
      </span>
      {index < 9 && (
        <span aria-hidden className="shrink-0 self-center text-xs text-subtle-foreground">
          {index + 1}
        </span>
      )}
    </label>
  ));
  // The last row is the free answer itself: its control picks it, the field holds the words.
  const otherRow = question.allowOther && (
    <div className="flex min-h-8 items-center gap-2.5 rounded-sm px-1.5 py-1 text-ui hover:bg-accent/50">
      <span className="relative shrink-0">{control(other, "Something else")}</span>
      <input
        ref={field}
        aria-label={`Something else: your answer to ${question.text}`}
        value={props.text}
        disabled={props.disabled}
        placeholder="Something else…"
        onFocus={() => {
          if (!props.picked.includes(other) && !question.multiSelect) props.onToggle(other);
        }}
        onChange={(event) => props.onText(event.target.value)}
        className="h-7 min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground"
      />
    </div>
  );
  return (
    <fieldset
      aria-labelledby={legend}
      data-question={question.id}
      className="flex flex-col gap-0.5"
    >
      <legend id={legend} className="mb-1.5 text-md leading-[1.35] font-medium tracking-[-0.005em]">
        {question.header && (
          <span className="mb-0.5 block text-xs font-normal text-subtle-foreground">
            {question.header}
          </span>
        )}
        {question.text}
      </legend>
      {question.multiSelect ? (
        <>
          {rows}
          {otherRow}
        </>
      ) : (
        <RadioGroup
          aria-labelledby={legend}
          value={props.picked[0] ?? ""}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            props.onToggle(value);
            if (value === other) field.current?.focus();
          }}
          className="gap-0.5"
        >
          {rows}
          {otherRow}
        </RadioGroup>
      )}
    </fieldset>
  );
}
