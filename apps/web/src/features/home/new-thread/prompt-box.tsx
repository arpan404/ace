import { ArrowUpIcon } from "@phosphor-icons/react";
import { cn } from "cn";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";

const singleLine = 26;

/**
 * The first message of a thread, Cursor-style: one pill-shaped line at rest that grows with the
 * text up to 40% of the viewport. Once it wraps, the controls drop to a row below so the
 * writing area is full width. Enter sends, Shift+Enter breaks the line.
 */
export function PromptBox(props: {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  canSend: boolean;
  sending: boolean;
  controls: ReactNode;
  placeholder: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [stacked, setStacked] = useState(false);
  // Length at which the text first wrapped; it unstacks only once shorter, so it can't flicker.
  const stackedAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    // After the shell moves focus to the new view's title, put it where the typing happens.
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    const length = props.value.length;
    if (stackedAt.current !== undefined && length < stackedAt.current)
      stackedAt.current = undefined;
    if (stackedAt.current === undefined && el.scrollHeight > singleLine + 4)
      stackedAt.current = length;
    setStacked(stackedAt.current !== undefined || props.value.includes("\n"));
  }, [props.value]);
  const send = (
    <Tip label="Start thread" keys="enter">
      <button
        type="button"
        aria-label="Start thread"
        disabled={!props.canSend || props.sending}
        onClick={props.onSend}
        className="grid size-[30px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-[background-color,opacity] duration-150 hover:bg-[color-mix(in_oklab,var(--primary),var(--background)_14%)] disabled:opacity-35"
      >
        {props.sending ? (
          <Spinner className="text-primary-foreground" />
        ) : (
          <ArrowUpIcon size={16} weight="bold" aria-hidden />
        )}
      </button>
    </Tip>
  );
  return (
    <div
      className={cn(
        "glass flex min-h-[46px] gap-1.5 py-[7px] pr-2 pl-4 transition-[border-radius,box-shadow] duration-200 ease-smooth focus-within:shadow-[0_0_0_4px_color-mix(in_oklab,var(--ring)_14%,transparent),var(--glass-shadow)]",
        stacked ? "flex-col rounded-2xl pt-3" : "items-center rounded-[23px]",
      )}
    >
      <textarea
        ref={input}
        rows={1}
        aria-label="What should the agent do?"
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (props.canSend && !props.sending) props.onSend();
        }}
        className="max-h-[40vh] min-h-[26px] w-full min-w-0 flex-1 resize-none bg-transparent py-[3px] text-[14.5px] leading-5 text-foreground outline-none placeholder:text-subtle-foreground"
      />
      <div className={cn("flex shrink-0 items-center gap-1", stacked && "justify-end")}>
        {props.controls}
        {send}
      </div>
    </div>
  );
}
