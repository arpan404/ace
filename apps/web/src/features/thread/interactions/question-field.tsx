import type { Question } from "@ace/protocol";
import { questionOptions } from "@ace/ui-core";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { useId, useRef, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Icon } from "@/components/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { cn } from "@/lib/cn.ts";
import { otherAnswer } from "./question-draft.ts";

/** A question with nothing to pick that takes words: the answer is its one field. */
export const typedOnly = (question: Question) =>
  question.options.length === 0 && question.allowOther;

/**
 * One question of the form: its header and text, then its answer. Options as radios (checkboxes
 * where several may be picked), each with its description under it, and, where the agent takes
 * free text, a last "Something else…" row that is itself the field to type in. A question with
 * no options is one field; a secret one hides what is typed.
 */
export function QuestionField(props: {
  question: Question;
  picked: readonly string[];
  text: string;
  /** At the start of the first line (the header, else the text): the request's icon. */
  lead?: ReactNode;
  /** At the end of the first line: the strip's pager. */
  aside?: ReactNode;
  disabled: boolean;
  onToggle(id: string): void;
  onText(text: string): void;
}) {
  const { question } = props;
  const legend = useId();
  const header = useId();
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
    <div className="flex min-h-8 items-center gap-2.5 rounded-sm px-1.5 py-1 text-ui hover:bg-accent/50 focus-within:bg-accent/50">
      <span className="relative shrink-0">{control(otherAnswer, "Something else")}</span>
      <input
        ref={field}
        type={question.secret ? "password" : "text"}
        autoComplete="off"
        aria-label={`Something else: your answer to ${question.text}`}
        value={props.text}
        disabled={props.disabled}
        placeholder="Something else…"
        // A click picks the free answer; tabbing through leaves the chosen option alone, and
        // the first keystroke picks it (`onText`).
        onPointerDown={() => {
          if (!props.picked.includes(otherAnswer) && !question.multiSelect)
            props.onToggle(otherAnswer);
        }}
        onChange={(event) => props.onText(event.target.value)}
        className="h-7 min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground focus-visible:placeholder:text-muted-foreground"
      />
    </div>
  );
  return (
    <fieldset
      aria-labelledby={question.header ? `${header} ${legend}` : legend}
      data-question={question.id}
      className="flex flex-col gap-0.5"
    >
      <div className="mb-1.5 flex flex-col gap-0.5">
        <div
          className={cn(
            "flex min-h-6 items-center gap-1.5",
            question.header
              ? "text-xs text-subtle-foreground"
              : "text-md leading-[1.35] font-medium tracking-[-0.005em]",
          )}
        >
          {props.lead && (
            <span className={cn("flex shrink-0", !question.header && "text-muted-foreground")}>
              {props.lead}
            </span>
          )}
          <span id={question.header ? header : legend} className="min-w-0 flex-1">
            {question.header ?? question.text}
          </span>
          {props.aside && <span className="ml-auto shrink-0">{props.aside}</span>}
        </div>
        {question.header && (
          <span id={legend} className="text-md leading-[1.35] font-medium tracking-[-0.005em]">
            {question.text}
          </span>
        )}
      </div>
      {typedOnly(question) ? (
        <TypedAnswer
          question={question}
          text={props.text}
          disabled={props.disabled}
          onText={props.onText}
        />
      ) : question.multiSelect ? (
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
            if (value === otherAnswer) field.current?.focus();
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

/** The one field of a question answered in words; a secret one types hidden, behind a lock. */
function TypedAnswer(props: {
  question: Question;
  text: string;
  disabled: boolean;
  onText(text: string): void;
}) {
  const { secret } = props.question;
  return (
    <label className="relative mt-0.5 block touch-hit">
      {secret && (
        <Icon
          icon={LockSimpleIcon}
          size={16}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle-foreground"
        />
      )}
      <Input
        type={secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        aria-label={props.question.text}
        value={props.text}
        disabled={props.disabled}
        placeholder="Type your answer"
        onChange={(event) => props.onText(event.target.value)}
        className={cn(secret && "pl-8")}
      />
    </label>
  );
}
