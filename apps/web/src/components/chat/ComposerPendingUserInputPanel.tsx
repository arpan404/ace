import { type ApprovalRequestId } from "@ace/contracts";
import { useEffect, useRef } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { APP_COMPOSER_CLASS_NAME } from "~/lib/appChrome";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

function clearWindowTimeoutRef(timeoutRef: { current: number | null }) {
  if (timeoutRef.current !== null) {
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }
}

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onPrevious: () => void;
  onAdvance: () => void;
}

export function ComposerPendingUserInputPanel({
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
}

function ComposerPendingUserInputCard({
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
      clearWindowTimeoutRef(autoAdvanceTimerRef);
    };
  }, []);

  const selectOptionAndAutoAdvance = (questionId: string, optionLabel: string) => {
    onSelectOption(questionId, optionLabel);
    if (activeQuestion?.multiSelect === true) {
      clearWindowTimeoutRef(autoAdvanceTimerRef);
      return;
    }
    clearWindowTimeoutRef(autoAdvanceTimerRef);
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      onAdvance();
    }, 200);
  };

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
      onSelectOption(activeQuestion.id, option.label);
      if (activeQuestion.multiSelect === true) {
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
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding, onAdvance, onSelectOption, progress.customAnswer.length]);

  if (!activeQuestion) {
    return null;
  }

  return (
    <section
      className={cn(
        APP_COMPOSER_CLASS_NAME,
        "overflow-hidden rounded-[1.375rem] border-border/45 text-popover-foreground shadow-[0_20px_54px_-42px_rgb(0_0_0/.82),0_1px_0_rgb(255_255_255/.065)_inset,0_-1px_0_rgb(0_0_0/.22)_inset] dark:border-border/30",
      )}
    >
      <div className="px-4 pb-2 pt-3">
        <p className="text-[12px] font-medium leading-5 text-foreground/86">
          {activeQuestion.question}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground/56">
          {activeQuestion.multiSelect
            ? "Select one or more options, then continue."
            : "Pick an option or press 1-9."}
        </p>
        {prompt.questions.length > 1 ? (
          <div className="mt-3 flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 rounded-md px-2 text-xs text-muted-foreground/72 hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-35"
              onClick={onPrevious}
              disabled={isResponding || questionIndex === 0}
              aria-label="Previous question"
            >
              Previous
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 rounded-md px-2 text-xs text-muted-foreground/72 hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-35"
              onClick={onAdvance}
              disabled={isResponding || !progress.canAdvance}
              aria-label={progress.isLastQuestion ? "Submit answers" : "Next question"}
            >
              {progress.isLastQuestion ? "Submit" : "Next"}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="space-y-0.5 px-3 pb-5">
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
                "group flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left transition-all duration-200",
                isSelected
                  ? "bg-primary/[0.075] text-foreground shadow-[0_0_0_1px_rgb(45_144_255/.28)_inset,0_1px_0_rgb(255_255_255/.045)_inset]"
                  : "text-foreground/76 hover:bg-black/[0.045] hover:text-foreground dark:hover:bg-white/[0.08]",
                isResponding && "cursor-not-allowed opacity-50",
              )}
            >
              {shortcutKey !== null ? (
                <kbd
                  className={cn(
                    "flex size-4.5 shrink-0 items-center justify-center rounded-md border text-[10px] font-semibold tabular-nums transition-all duration-200",
                    isSelected
                      ? "border-primary/35 bg-primary/14 text-primary"
                      : "border-border/45 bg-foreground/[0.035] text-muted-foreground/58",
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
              <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
                <span className="shrink-0 text-[12px] font-medium leading-5 sm:whitespace-nowrap">
                  {option.label}
                </span>
                {option.description && option.description !== option.label ? (
                  <span className="block min-w-0 truncate text-[11px] leading-5 text-muted-foreground/50 sm:inline">
                    {option.description}
                  </span>
                ) : null}
              </div>
              {isSelected ? <CheckIcon className="size-3 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
