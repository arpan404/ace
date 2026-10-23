import { useNavigate } from "@tanstack/react-router";
import type { ForgePrRow } from "@ace/protocol";
import {
  prStepLabels,
  type LocalCheckResult,
  type PrNextStep,
  type LinkedThread,
  agentRequest,
} from "@ace/ui-core";
import { useToast } from "@/components/ui/toast.tsx";
import { insertTextWhenMounted } from "@/lib/composer-insert.ts";
import { cn } from "@/lib/cn.ts";

/** The step's text button: one word or two, flat, overhanging the gutter by its padding. */
const stepText = "inline-flex h-5 items-center rounded-sm px-1.5 text-xs font-medium";

/**
 * The space a row's step button takes at the end of its second line, drawn invisibly inside
 * the row's link so the visible button, which sits outside the link, never covers the age.
 */
export function StepSpace(props: { label: string | undefined }) {
  if (!props.label) return null;
  return (
    <span aria-hidden className={cn(stepText, "invisible -mr-1.5 ml-1")}>
      {props.label}
    </span>
  );
}

/** The step a row shows as its button: its word, unless nothing is the viewer's to press. */
export function stepLabel(step: PrNextStep): string | undefined {
  return prStepLabels[step];
}

/**
 * What each step's button does from the list: Answer opens the thread, Review the PR's code,
 * Update its page (where the update lives), and Fix, Address and Resolve hand the PR to its
 * thread's agent, as a request in that thread's composer to read over and send, or to a new
 * thread when none is linked.
 */
export function useStepAction(project: string, back: string) {
  const navigate = useNavigate();
  const toast = useToast();
  const openPr = (row: ForgePrRow, tab?: "code") =>
    void navigate({
      to: "/pulls/$project/$number",
      params: { project, number: String(row.ref.number) },
      search: { back, ...(tab ? { tab } : {}) },
    });
  return (input: {
    step: PrNextStep;
    row: ForgePrRow;
    thread: LinkedThread | undefined;
    local: LocalCheckResult;
    command: string | null | undefined;
  }) => {
    const { step, row, thread } = input;
    if (step === "answer" && thread) {
      void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
      return;
    }
    if (step === "review") return openPr(row, "code");
    const request = agentRequest(step, row, input.local, input.command);
    if (!request) return openPr(row);
    if (!thread) {
      void navigate({ to: "/new", search: { project, pullRequest: row.url } });
      return;
    }
    void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    void insertTextWhenMounted(thread.id, request).then((inserted) => {
      if (!inserted)
        toast.error({
          title: "Couldn't add the request",
          description: "Open the thread and try again.",
        });
    });
  };
}

/**
 * The row's step as one text button, laid over the space `StepSpace` keeps for it. Merge
 * toggles the row in the merge selection (`pressed`), reading "Selected" while it is in; the
 * others act at once.
 */
export function StepButton(props: {
  label: string;
  title: string;
  pressed?: boolean | undefined;
  disabled?: string | undefined;
  onPress(): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      aria-label={`${props.label}: ${props.title}`}
      title={props.disabled}
      disabled={props.disabled !== undefined}
      onClick={props.onPress}
      className={cn(
        stepText,
        "absolute right-[calc(var(--forge-gutter)-0.375rem)] bottom-2.5 text-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover disabled:opacity-50",
      )}
    >
      {props.pressed ? "Selected" : props.label}
    </button>
  );
}
