import { useRef, useState } from "react";
import { Input } from "@/components/ui/input.tsx";
import { useThreadActions, type ThreadTarget } from "./use-thread-actions.ts";

/** The title's shared field: Enter or blur saves; Escape keeps the original. */
export function InlineRename(props: {
  thread: ThreadTarget;
  initialTitle?: string;
  onDone(): void;
}) {
  const actions = useThreadActions();
  const [title, setTitle] = useState(props.initialTitle ?? props.thread.title);
  const finished = useRef(false);
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
        save();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) save();
      }}
    >
      <Input
        aria-label="Thread title"
        value={title}
        maxLength={256}
        autoFocus
        onFocus={(event) => {
          event.currentTarget.select();
          event.currentTarget.scrollLeft = 0;
        }}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
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
