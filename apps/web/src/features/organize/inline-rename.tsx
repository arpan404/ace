import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input.tsx";
import { useThreadActions, type ThreadTarget } from "./use-thread-actions.ts";

/** The title's shared field: Enter or blur saves; Escape keeps the original. */
export interface InlineRenameProps {
  thread: ThreadTarget;
  initialTitle?: string;
  onTitleChange?(title: string): void;
  onDone(): void;
}

export function InlineRename(props: InlineRenameProps) {
  const actions = useThreadActions();
  const [title, setTitle] = useState(props.initialTitle ?? props.thread.title);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const composing = useRef(false);
  useEffect(() => {
    // Menus return focus to their opener before the title field takes it.
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const save = () => {
    if (finished.current || !title.trim()) return;
    finished.current = true;
    actions.rename(props.thread, title);
    props.onDone();
  };
  return (
    <form
      data-inline-rename
      className="min-w-0 flex-1"
      aria-label="Rename thread"
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        if (!composing.current) save();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) save();
      }}
    >
      <Input
        ref={input}
        aria-label="Thread title"
        value={title}
        maxLength={256}
        onFocus={(event) => {
          event.currentTarget.select();
          event.currentTarget.scrollLeft = 0;
        }}
        onChange={(event) => {
          setTitle(event.target.value);
          props.onTitleChange?.(event.target.value);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            finished.current = true;
            props.onDone();
          }
        }}
      />
    </form>
  );
}
