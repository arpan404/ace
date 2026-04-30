import { type ApprovalRequestId } from "@ace/contracts";
import { memo, useCallback, useEffect, useRef } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, ListChecksIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onPrevious: () => void;
  onAdvance: () => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onSelectOption,
  onPrevious,
  onAdvance,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onSelectOption={onSelectOption}
      onPrevious={onPrevious}
      onAdvance={onAdvance}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onSelectOption,
  onPrevious,
  onAdvance,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onPrevious: () => void;
  onAdvance: () => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const selectOptionAndAutoAdvance = useCallback(
    (questionId: string, optionLabel: string) => {
      onSelectOption(questionId, optionLabel);
      if (activeQuestion?.multiSelect === true) {
        if (autoAdvanceTimerRef.current !== null) {
          window.clearTimeout(autoAdvanceTimerRef.current);
          autoAdvanceTimerRef.current = null;
        }
        return;
      }
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        onAdvance();
      }, 200);
    },
    [activeQuestion?.multiSelect, onSelectOption, onAdvance],
  );

  // Keyboard shortcut: number keys 1-9 pick the corresponding option. Single-select
  // prompts auto-advance; multi-select prompts toggle the option in place.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      // If the user has started typing a custom answer in the contenteditable
      // composer, let digit keys pass through so they can type numbers.
      if (target instanceof HTMLElement && target.isContentEditable) {
        const hasCustomText = progress.customAnswer.length > 0;
        if (hasCustomText) return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOptionAndAutoAdvance(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding, selectOptionAndAutoAdvance, progress.customAnswer.length]);

  if (!activeQuestion) {
    return null;
  }

  return (
    <section className="overflow-hidden rounded-[14px] border border-border/60 bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border/55 bg-background/80 text-muted-foreground/70">
            <ListChecksIcon className="size-3" />
          </span>
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/70 uppercase">
            Input request
          </span>
          {prompt.questions.length > 1 ? (
            <span className="rounded-full border border-border/55 bg-background/85 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground/75">
              {questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
        </div>
        {prompt.questions.length > 1 ? (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-7 rounded-md text-muted-foreground/72 hover:bg-muted/35 hover:text-foreground disabled:opacity-35"
              onClick={onPrevious}
              disabled={isResponding || questionIndex === 0}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-7 rounded-md text-muted-foreground/72 hover:bg-muted/35 hover:text-foreground disabled:opacity-35"
              onClick={onAdvance}
              disabled={isResponding || !progress.canAdvance}
              aria-label={progress.isLastQuestion ? "Submit answers" : "Next question"}
            >
              <ChevronRightIcon className="size-3.5" />
            </Button>
          </div>
        ) : (
          <span className="truncate text-[10px] font-medium tracking-[0.14em] text-muted-foreground/52 uppercase">
            {activeQuestion.header}
          </span>
        )}
      </div>
      <div className="px-3 py-3">
        <p className="text-[13px] leading-6 text-foreground/88">{activeQuestion.question}</p>
        <p className="mt-1 text-[11px] text-muted-foreground/56">
          {activeQuestion.multiSelect
            ? "Select one or more options, then continue."
            : "Pick an option or press 1-9."}
        </p>
      </div>
      <div>
        {activeQuestion.options.map((option, index) => {
          const isSelected = progress.selectedOptionLabels.includes(option.label);
          const shortcutKey = index < 9 ? index + 1 : null;
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              disabled={isResponding}
              aria-pressed={isSelected}
              onClick={() => selectOptionAndAutoAdvance(activeQuestion.id, option.label)}
              className={cn(
                "group flex w-full items-center gap-3 border-t border-border/50 px-3 py-2.5 text-left transition-all duration-200 first:border-t-0",
                isSelected
                  ? "bg-primary/6 text-foreground"
                  : "text-foreground/82 hover:bg-muted/35",
                isResponding && "cursor-not-allowed opacity-50",
              )}
            >
              {shortcutKey !== null ? (
                <kbd
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold tabular-nums transition-all duration-200",
                    isSelected
                      ? "border-primary/30 bg-primary/12 text-primary"
                      : "border-border/55 bg-background/80 text-muted-foreground/55",
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
              <div className="min-w-0 flex-1">
                <span className="text-[13px] font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="ml-2 text-[11px] text-muted-foreground/52">
                    {option.description}
                  </span>
                ) : null}
              </div>
              {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
});
