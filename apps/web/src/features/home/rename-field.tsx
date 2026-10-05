import type { ThreadListEntry } from "@ace/protocol";
import { useEffect, useRef } from "react";
import { useOrganizeOverlay, useThreadActions } from "@/features/organize/index.ts";

/**
 * Inline rename in place of the title. Enter or leaving the field saves; Escape cancels. The new
 * title shows at once; should the daemon refuse it, the field opens again with what was typed.
 */
export function RenameField(props: { entry: ThreadListEntry; title: string; onDone(): void }) {
  const actions = useThreadActions();
  const overlay = useOrganizeOverlay();
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    // After the menu closes and returns focus to the row, take it for the field.
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    overlay.takeRefusedTitle(props.entry.id);
    if (save && input.current) actions.rename(props.entry, input.current.value);
    props.onDone();
  };
  return (
    <input
      ref={input}
      aria-label="Thread title"
      defaultValue={props.title}
      maxLength={200}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
      className="col-span-2 -mx-1 h-[22px] w-full min-w-0 rounded-sm bg-transparent px-1 text-base font-medium text-foreground shadow-[inset_0_0_0_1px_var(--ring)] outline-none"
    />
  );
}
