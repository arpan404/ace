import { memo, useCallback, useRef, useState, type FormEvent } from "react";

import { clampCollapsedComposerCursor } from "../../composer-logic";
import { cn } from "../../lib/utils";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

interface SideChatComposerProps {
  readonly className?: string;
  readonly disabled?: boolean;
  readonly error: string | null;
  readonly isSending: boolean;
  readonly placeholder: string;
  readonly onSubmit: (prompt: string) => Promise<void> | void;
}

export const SideChatComposer = memo(function SideChatComposer(props: SideChatComposerProps) {
  const { disabled: disabledProp, error, isSending, onSubmit, placeholder } = props;
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const trimmedPrompt = prompt.trim();
  const hasSendableContent = trimmedPrompt.length > 0;
  const disabled = disabledProp === true;

  const handlePromptChange = useCallback((nextValue: string, nextCursor: number) => {
    setPrompt(nextValue);
    setCursor(clampCollapsedComposerCursor(nextValue, nextCursor));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!hasSendableContent || disabled || isSending) {
        return;
      }
      const submittedPrompt = trimmedPrompt;
      await onSubmit(submittedPrompt);
      setPrompt("");
      setCursor(0);
      queueMicrotask(() => {
        editorRef.current?.focusAtEnd();
      });
    },
    [disabled, hasSendableContent, isSending, onSubmit, trimmedPrompt],
  );

  return (
    <div className={cn("shrink-0 px-3 pb-3 pt-0 sm:px-5", props.className)}>
      <form
        ref={formRef}
        className="mx-auto w-full min-w-0 max-w-208"
        data-chat-composer-form="true"
        onSubmit={handleSubmit}
      >
        <div className="group rounded-xl transition-colors duration-200">
          <div className="rounded-xl border border-border/25 bg-input transition-[border-color,box-shadow] duration-200 focus-within:border-transparent focus-within:ring-2 focus-within:ring-ring/40 focus-within:shadow-sm">
            <div className="relative px-3 pb-2 pt-2 sm:px-4 sm:pt-2.5">
              <ComposerPromptEditor
                ref={editorRef}
                value={prompt}
                cursor={cursor}
                terminalContexts={[]}
                disabled={disabled}
                placeholder={placeholder}
                onRemoveTerminalContext={() => {}}
                onChange={handlePromptChange}
                onCommandKeyDown={(key, event) => {
                  if (key !== "Enter" || event.shiftKey) {
                    return false;
                  }
                  formRef.current?.requestSubmit();
                  return true;
                }}
                onPaste={() => {}}
              />
            </div>
            <div className="flex min-w-0 flex-nowrap items-center justify-between overflow-hidden px-2.5 pb-2 sm:px-3 sm:pb-2.5">
              <div className="min-w-0 flex-1" />
              <ComposerPrimaryActions
                compact={false}
                pendingAction={null}
                isRunning={false}
                showPlanFollowUpPrompt={false}
                promptHasText={hasSendableContent}
                isSendBusy={isSending}
                isConnecting={disabled}
                isPreparingWorktree={false}
                hasSendableContent={hasSendableContent}
                canQueueMessage={false}
                onInterrupt={() => {}}
                onImplementPlanInNewThread={() => {}}
                onQueueMessage={() => {}}
              />
            </div>
          </div>
        </div>
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </form>
    </div>
  );
});
