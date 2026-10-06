import type { Interaction, InteractionRequest } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { privateBrowserGate, questionOptions } from "@ace/ui-core";
import { PrivateBrowserNotice } from "@/components/private-browser-notice.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import {
  ButtonKey,
  CardActions,
  CardError,
  OpenThreadAction,
  useCardFocused,
} from "./card-frame.tsx";
import { confirmations, useAnswer } from "./use-answer.ts";

export function requestTitle(request: InteractionRequest): string {
  switch (request.kind) {
    case "approval":
      return request.title;
    case "question":
      return request.questions[0]?.text ?? "Question";
    case "plan_review":
      return request.title ?? "Review the plan";
    case "elicitation":
      return request.message;
  }
}

const numberKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/**
 * A single single-choice question is answered right here: click an option or press its
 * number. Anything richer (several questions, multi-select) is answered in the thread.
 */
export function QuestionBody(props: { interaction: Interaction; cardKey: string }) {
  const { interaction } = props;
  const request = interaction.request;
  const questions = request.kind === "question" ? request.questions : [];
  const question = questions[0];
  const inline = questions.length === 1 && question !== undefined && !question.multiSelect;
  const focused = useCardFocused(props.cardKey);
  const { answer, sending, failure } = useAnswer(interaction.id);
  const options = question ? questionOptions(question) : [];
  const choose = (index: number) => {
    const option = options[index];
    if (!inline || !question || !option) return;
    answer({ kind: "question", answers: { [question.id]: [option.id] } }, confirmations.answered);
  };
  return (
    <>
      {questions.length > 1 && (
        <p className="mb-2 text-sm text-muted-foreground">
          {questions.length} questions. Answer them in the thread.
        </p>
      )}
      <div role="group" aria-label="Options" className="mt-1 flex flex-col gap-1.5">
        {options.map((option, index) => (
          <OptionButton
            key={option.id}
            index={index}
            label={option.label}
            description={option.description}
            recommended={option.recommended}
            disabled={!inline || sending}
            focused={focused && inline && !sending}
            onChoose={() => choose(index)}
          />
        ))}
      </div>
      <CardError message={failure} />
      <OpenThreadAction threadId={interaction.threadId} cardKey={props.cardKey} />
    </>
  );
}

function OptionButton(props: {
  index: number;
  label: string;
  description: string | undefined;
  recommended: boolean;
  disabled: boolean;
  focused: boolean;
  onChoose(): void;
}) {
  const key = numberKeys[props.index];
  useHotkey(key ?? "", props.onChoose, { enabled: props.focused && key !== undefined });
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onChoose}
      className="flex items-center gap-2.5 rounded-[10px] bg-muted px-3 py-[9px] text-left text-ui transition-colors duration-(--dur-1) hover:bg-accent disabled:cursor-default disabled:hover:bg-muted"
    >
      {key && (
        <Kbd aria-hidden className="shrink-0">
          {key}
        </Kbd>
      )}
      <span className="min-w-0">
        {props.label}
        {props.description && <span className="text-muted-foreground"> · {props.description}</span>}
      </span>
      {props.recommended && (
        <small className="ml-auto shrink-0 text-[12px] text-subtle-foreground">recommended</small>
      )}
    </button>
  );
}

/** A plan waiting for review: its summary, then Request changes (D) or Approve plan (A). */
export function PlanBody(props: { interaction: Interaction; cardKey: string }) {
  if (privateBrowserGate(props.interaction))
    return (
      <>
        <PrivateBrowserNotice />
        <OpenThreadAction threadId={props.interaction.threadId} cardKey={props.cardKey} />
      </>
    );
  return <PlanReviewBody interaction={props.interaction} cardKey={props.cardKey} />;
}

function PlanReviewBody(props: { interaction: Interaction; cardKey: string }) {
  const { interaction } = props;
  const request = interaction.request;
  const summary = request.kind === "plan_review" ? (request.summary ?? request.markdown) : "";
  const focused = useCardFocused(props.cardKey);
  const { answer, sending, failure } = useAnswer(interaction.id);
  const approve = () =>
    answer({ kind: "plan_review", decision: "approve" }, confirmations.planApproved);
  const reject = () =>
    answer({ kind: "plan_review", decision: "reject" }, confirmations.planRejected);
  useHotkey("a", approve, { enabled: focused && !sending });
  useHotkey("d", reject, { enabled: focused && !sending });
  return (
    <>
      <p className="line-clamp-4 text-[13.5px] leading-normal whitespace-pre-line text-muted-foreground">
        {summary}
      </p>
      <CardActions>
        <Button variant="ghost" disabled={sending} onClick={reject}>
          Request changes
          <ButtonKey>D</ButtonKey>
        </Button>
        <Button variant="primary" disabled={sending} onClick={approve}>
          Approve plan
          <ButtonKey primary>A</ButtonKey>
        </Button>
      </CardActions>
      <CardError message={failure} />
    </>
  );
}
