import type { Question } from "@ace/protocol";
import { cn } from "@/lib/cn.ts";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { Answer } from "./answer.ts";

const other = "__other__";

/** One or more questions with options; free text where the agent accepts it. */
export function QuestionForm(props: {
  questions: readonly Question[];
  disabled: boolean;
  onAnswer: Answer;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const complete = props.questions.every((question) => {
    const choice = picked[question.id] ?? [];
    return choice.length > 0 && (!choice.includes(other) || !!texts[question.id]?.trim());
  });
  const submit = () => {
    const answers: Record<string, string[]> = {};
    for (const question of props.questions)
      answers[question.id] = (picked[question.id] ?? []).map((id) =>
        id === other ? (texts[question.id] ?? "").trim() : id,
      );
    props.onAnswer({ kind: "question", answers });
  };
  const toggle = (question: Question, id: string) =>
    setPicked((previous) => {
      const current = previous[question.id] ?? [];
      const next = question.multiSelect
        ? current.includes(id)
          ? current.filter((value) => value !== id)
          : [...current, id]
        : [id];
      return { ...previous, [question.id]: next };
    });
  return (
    <form
      className="mt-2 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) submit();
      }}
    >
      {props.questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          picked={picked[question.id] ?? []}
          text={texts[question.id] ?? ""}
          disabled={props.disabled}
          onToggle={(id) => toggle(question, id)}
          onText={(text) => setTexts((previous) => ({ ...previous, [question.id]: text }))}
        />
      ))}
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
  const type = question.multiSelect ? "checkbox" : "radio";
  const options = [
    ...question.options,
    ...(question.allowOther
      ? [{ id: other, label: "Something else", description: undefined }]
      : []),
  ];
  return (
    <fieldset aria-labelledby={legend} className="flex flex-col gap-1.5">
      <legend id={legend} className="mb-1.5 text-md leading-[1.35] font-medium tracking-[-0.005em]">
        {question.header && (
          <span className="mb-0.5 block text-xs font-normal text-subtle-foreground">
            {question.header}
          </span>
        )}
        {question.text}
      </legend>
      {options.map((option) => {
        const checked = props.picked.includes(option.id);
        return (
          <label
            key={option.id}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-[10px] bg-muted px-3 py-[9px] text-ui transition-colors duration-150 hover:bg-accent",
              checked && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ring)_55%,transparent)]",
            )}
          >
            <input
              type={type}
              name={question.id}
              checked={checked}
              disabled={props.disabled}
              onChange={() => props.onToggle(option.id)}
              className="accent-(--ring)"
            />
            <span>{option.label}</span>
            {option.description && (
              <span className="text-subtle-foreground">· {option.description}</span>
            )}
          </label>
        );
      })}
      {props.picked.includes(other) && (
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
