import type { Mention } from "@ace/protocol";
import { ArrowUpIcon, PlusIcon, StopIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { ThreadRef } from "../sources/index.ts";
import { AttachmentChips, useAttachments } from "./attachments.tsx";
import { accept, mentionsIn, triggerAt, type Trigger } from "./draft.ts";
import { SuggestionList, useSuggestions, type Suggestion } from "./suggestions.tsx";

export interface Draft {
  text: string;
  mentions: Mention[];
  attachments: { sha256: string }[];
  /** ⌘↵: deliver into the running turn instead of waiting for the agent to be free. */
  steer: boolean;
}

/**
 * Cursor-style composer: a one-line glass pill at rest that grows to 40vh and drops its
 * controls to a bottom row once the text wraps. `@` completes files, a leading `/` completes
 * commands, + attaches files and images (paste and drop work too).
 */
export function Composer(props: {
  thread: ThreadRef;
  /** The agent is busy: Enter queues, ⌘↵ steers, and an empty composer offers Stop. */
  busy: boolean;
  onSubmit(draft: Draft): Promise<boolean>;
  onStop?: (() => void) | undefined;
  /** Controls left of the send button, e.g. the model picker. */
  controls?: ReactNode;
  placeholder?: string | undefined;
  autoFocus?: boolean | undefined;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number>();
  const [highlight, setActive] = useState({ key: "", index: 0 });
  const [stacked, setStacked] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const picked = useRef(new Set<string>());
  // Where to put the caret once an accepted suggestion has rendered.
  const placeCaret = useRef<number | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const listId = useId();
  const attachments = useAttachments(props.thread);
  const found = triggerAt(text, caret);
  const trigger: Trigger | undefined = found && found.start !== dismissed ? found : undefined;
  const suggestions = useSuggestions(props.thread, trigger);
  const open = suggestions.length > 0;
  // The highlight resets whenever the token being completed changes.
  const listKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : "";
  const active = highlight.key === listKey ? highlight.index : 0;
  const empty = !text.trim() && !attachments.items.length;
  const canSend = !empty && !attachments.uploading;

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 14.5 * 1.4;
    el.style.height = `${Math.min(el.scrollHeight, innerHeight * 0.4)}px`;
    setStacked(text.includes("\n") || el.scrollHeight > lineHeight + 16 + 4);
    if (placeCaret.current !== undefined) {
      el.setSelectionRange(placeCaret.current, placeCaret.current);
      placeCaret.current = undefined;
    }
  }, [text]);
  useEffect(() => {
    const el = input.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setNarrow(el.clientWidth < 400));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pick = (item: Suggestion) => {
    if (!trigger) return;
    if (item.path) picked.current.add(item.path);
    const next = accept(text, trigger, item.insert);
    setText(next.text);
    setCaret(next.caret);
    placeCaret.current = next.caret;
  };
  const submit = async (steer: boolean) => {
    if (!canSend) return;
    const draft: Draft = {
      text: text.trim(),
      mentions: mentionsIn(text, picked.current),
      attachments: attachments.ready,
      steer,
    };
    setText("");
    setCaret(0);
    attachments.clear();
    picked.current.clear();
    if (!(await props.onSubmit(draft))) setText(draft.text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && trigger) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive({
          key: listKey,
          index: (active + step + suggestions.length) % suggestions.length,
        });
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        const item = suggestions[active];
        if (item) pick(item);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(trigger.start);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit(event.metaKey || event.ctrlKey);
    }
  };
  const stopping = props.busy && empty && !!props.onStop;
  const layout = stacked || attachments.items.length > 0;
  const placeholder =
    props.placeholder ?? (narrow ? "Ask anything" : "Ask anything, @ to mention, / for commands");

  return (
    <div className="relative">
      <SuggestionList id={listId} items={suggestions} active={active} onPick={pick} />
      <div
        style={{
          gridTemplateAreas: layout
            ? '"chips chips chips" "input input input" "plus space ctrls"'
            : '"chips chips chips" "plus input ctrls"',
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          attachments.add(event.dataTransfer.files);
        }}
        className={cn(
          "glass grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-1 py-[5px] pr-[5px] pl-1.5 transition-[box-shadow,border-color,border-radius] duration-200",
          "focus-within:border-[color-mix(in_oklab,var(--foreground)_22%,var(--glass-border))] focus-within:shadow-[var(--glass-highlight),0_0_0_0.5px_var(--glass-edge),var(--glass-shadow),0_0_0_4px_color-mix(in_oklab,var(--foreground)_6%,transparent)]",
          layout ? "rounded-xl" : "rounded-full",
        )}
      >
        <div className="[grid-area:chips]">
          <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
        </div>
        <Tip label="Attach files or images">
          <button
            type="button"
            aria-label="Attach files or images"
            onClick={() => file.current?.click()}
            className="grid size-[34px] place-items-center rounded-card text-muted-foreground transition-colors duration-150 [grid-area:plus] hover:bg-accent hover:text-foreground"
          >
            <PlusIcon aria-hidden size={20} />
          </button>
        </Tip>
        <input
          ref={file}
          type="file"
          multiple
          hidden
          aria-label="Files to attach"
          onChange={(event) => {
            if (event.target.files) attachments.add(event.target.files);
            event.target.value = "";
          }}
        />
        <textarea
          ref={input}
          rows={1}
          value={text}
          autoFocus={props.autoFocus}
          aria-label="Message"
          placeholder={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = event.clipboardData.files;
            if (files.length) {
              event.preventDefault();
              attachments.add(files);
            }
          }}
          className={cn(
            "max-h-[40vh] min-h-9 w-full resize-none self-center overflow-y-auto bg-transparent text-[14.5px] leading-[1.4] text-foreground outline-none [grid-area:input] placeholder:text-subtle-foreground",
            layout ? "px-2.5 pt-2.5 pb-1.5" : "py-2 pr-1.5 pl-2",
          )}
        />
        <div className={cn("flex items-center gap-1 [grid-area:ctrls]", layout && "pt-0.5")}>
          {props.controls}
          {stopping ? (
            <Tip label="Stop the agent and its subagents">
              <button
                type="button"
                aria-label="Stop the agent"
                onClick={props.onStop}
                className="grid size-8 place-items-center rounded-full bg-secondary text-foreground transition-[transform,background-color] duration-150 hover:scale-105 hover:bg-accent active:scale-95"
              >
                <StopIcon aria-hidden size={12} weight="fill" />
              </button>
            </Tip>
          ) : (
            <Tip
              label={props.busy ? "Queue · sends when the agent is free" : "Send"}
              keys={props.busy ? "enter" : "mod+enter"}
            >
              <button
                type="button"
                aria-label={props.busy ? "Queue message" : "Send"}
                disabled={!canSend}
                onClick={() => void submit(false)}
                className={cn(
                  "grid size-8 place-items-center rounded-full transition-[transform,background-color,opacity] duration-150",
                  canSend
                    ? "bg-primary text-primary-foreground shadow-[0_1px_2px_rgb(0_0_0/0.18)] hover:scale-105 active:scale-95"
                    : "bg-secondary text-subtle-foreground",
                )}
              >
                <ArrowUpIcon aria-hidden size={16} weight="bold" />
              </button>
            </Tip>
          )}
        </div>
      </div>
    </div>
  );
}
