import { type ApprovalRequestId } from "@ace/contracts";
import { memo, useCallback, useEffect, useRef } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onSelectOption,
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
  onAdvance,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
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
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          {prompt.questions.length > 1 ? (
            <span className="flex h-[18px] items-center rounded-full bg-primary/8 px-2 text-[10px] font-semibold tabular-nums text-primary/70">
              {questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
          <span className="text-[10px] font-semibold tracking-[0.2em] text-muted-foreground/45 uppercase">
            {activeQuestion.header}
          </span>
        </div>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-foreground/85">
        {activeQuestion.question}
      </p>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-[11px] text-muted-foreground/50">
          Select one or more options, then continue.
        </p>
      ) : null}
      <div className="mt-3 space-y-1.5">
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
                "group flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all duration-200",
                isSelected
                  ? "border-primary/30 bg-primary/6 text-foreground  "
                  : "border-border/25 bg-muted/12 text-foreground/80 hover:border-border/45 hover:bg-muted/30",
                isResponding && "opacity-50 cursor-not-allowed",
              )}
            >
              {shortcutKey !== null ? (
                <kbd
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums transition-all duration-200",
                    isSelected
                      ? "bg-primary/15 text-primary  "
                      : "bg-muted/30 text-muted-foreground/40 group-hover:bg-muted/50 group-hover:text-muted-foreground/60",
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
              <div className="min-w-0 flex-1">
                <span className="text-[13px] font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="ml-2 text-[11px] text-muted-foreground/45">
                    {option.description}
                  </span>
                ) : null}
              </div>
              {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
});
