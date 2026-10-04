import type { Mention } from "@ace/protocol";
import {
  Suspense,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { ThreadRef } from "../sources/index.ts";
import { AddButton } from "./add-button.tsx";
import { AttachmentChips, useAttachments } from "./attachments.tsx";
import { ComposerCompact } from "./composer-compact.ts";
import { accept, insertAt, mentionsIn, triggerAt, type Trigger } from "./draft.ts";
import { readDraft, recentFiles, rememberFile } from "./draft-store.ts";
import { PrimaryAction } from "./primary-action.tsx";
import { DeferredSuggestionList } from "./deferred-parts.tsx";
import { useSuggestions, type Suggestion } from "./suggestions.tsx";
import { useAutosize } from "./use-autosize.ts";
import { useDraftPersistence } from "./use-draft-persistence.ts";

export interface Draft {
  text: string;
  mentions: Mention[];
  attachments: { sha256: string }[];
  /** ⌘↵ / Ctrl+↵: the opposite of the follow-up default (steer instead of queue, or back). */
  opposite: boolean;
}

/** Below this width the footer drops labels to icons; below `terse` the hint shortens. */
const compactWidth = 480;
const terseWidth = 640;

/**
 * The composer: an input area above a footer, inside one shell, at every width and line count
 * (SPEC "Composer"). Text keeps one inset from empty to many lines and grows upward a line at a
 * time; the footer's controls share one centre line. + opens the Add menu, `@` completes files,
 * a leading `/` completes commands, and paste or drop attach files. The unsent draft is kept per
 * `draftKey` across navigation and reloads, and cleared once the daemon has the message.
 */
export function Composer(props: {
  thread: ThreadRef;
  /** Where this device keeps the unsent draft; without one it lives only while mounted. */
  draftKey?: string | undefined;
  /** Uploaded files outlive a reload only where the daemon keeps them: an existing thread. */
  keepsAttachments?: boolean | undefined;
  /** The agent is busy: an empty composer offers Stop and a message follows up. */
  busy: boolean;
  /** What Enter does with a follow-up while busy; ⌘↵ does the other. Defaults to queue. */
  followUp?: "queue" | "steer" | undefined;
  onSubmit(draft: Draft): Promise<boolean>;
  onStop?: (() => void) | undefined;
  /** Footer controls after +, e.g. approvals and the model; they read `useComposerCompact()`. */
  controls?: ReactNode;
  /** Right of the controls, before the primary action, e.g. the context meter. */
  status?: ReactNode;
  /** Why images can't be added, when the provider doesn't read them. */
  imagesUnavailable?: string | undefined;
  placeholder?: string | undefined;
  autoFocus?: boolean | undefined;
}) {
  const { storage } = useLayout();
  const [restored] = useState(() =>
    props.draftKey ? readDraft(storage, props.draftKey) : undefined,
  );
  const [text, setText] = useState(restored?.text ?? "");
  const [sending, setSending] = useState(false);
  const [caret, setCaret] = useState(text.length);
  const [dismissed, setDismissed] = useState<number>();
  const [highlight, setActive] = useState({ key: "", index: 0 });
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(restored?.mentions));
  // Where to put the caret once an inserted suggestion has rendered.
  const placeCaret = useRef<number | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const attachments = useAttachments(
    props.thread,
    props.keepsAttachments ? restored?.attachments : undefined,
  );
  const found = triggerAt(text, caret);
  const trigger: Trigger | undefined = found && found.start !== dismissed ? found : undefined;
  const suggestions = useSuggestions(props.thread, trigger);
  const items = suggestions.state === "ready" ? suggestions.items : [];
  // The highlight resets whenever the token being completed changes.
  const listKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : "";
  const active = highlight.key === listKey ? highlight.index : 0;
  const empty = !text.trim() && !attachments.items.length;
  const compact = width > 0 && width < compactWidth;
  const terse = width > 0 && width < terseWidth;

  const saved = useDraftPersistence(props.draftKey, {
    text,
    mentions: [...picked],
    attachments: props.keepsAttachments ? attachments.ready : [],
  });
  useAutosize(input, text, width);
  // After an inserted suggestion or mention has rendered, put the caret after it.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || placeCaret.current === undefined) return;
    el.setSelectionRange(placeCaret.current, placeCaret.current);
    placeCaret.current = undefined;
  });
  // The composer's own width picks the compact footer and the hint. Measured before the first
  // paint, then whenever the reading column changes (a panel opening, a resize).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      // Layout width, so a panel's transform mid-animation never skews it; an element that
      // isn't laid out (hidden, detached) keeps the last decision.
      if (el.offsetWidth > 0) setWidth(el.offsetWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const edit = (next: { text: string; caret: number }) => {
    setText(next.text);
    setCaret(next.caret);
    placeCaret.current = next.caret;
    input.current?.focus();
  };
  const mention = (path: string) => {
    setPicked((paths) => new Set(paths).add(path));
    rememberFile(storage, props.thread.workspaceId, path);
  };
  const pick = (item: Suggestion) => {
    if (!trigger) return;
    if (item.path) mention(item.path);
    edit(accept(text, trigger, item.insert));
  };
  const blocked = sending
    ? "Sending…"
    : attachments.uploading
      ? "Waiting for the files to upload"
      : empty
        ? "Write a message first"
        : undefined;
  // The draft stays until the daemon has it, so a refusal never loses the text or files.
  const submit = async (opposite: boolean) => {
    if (blocked) return;
    const draft: Draft = {
      text: text.trim(),
      mentions: mentionsIn(text, picked),
      attachments: attachments.ready.map((file) => ({ sha256: file.sha256 })),
      opposite,
    };
    setSending(true);
    try {
      if (!(await props.onSubmit(draft))) return;
      saved.discard();
      setText("");
      setCaret(0);
      attachments.clear();
      setPicked(new Set());
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && suggestions.state !== "closed") {
      if (items.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive({ key: listKey, index: (active + step + items.length) % items.length });
        return;
      }
      if (items.length && ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab")) {
        event.preventDefault();
        const item = items[active];
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
  const mode = props.busy
    ? empty && props.onStop
      ? "stop"
      : props.followUp === "steer"
        ? "steer"
        : "queue"
    : "send";
  const unscoped =
    props.thread.draft && !props.thread.id ? "Waiting for the daemon to open a draft" : undefined;
  const placeholder =
    props.placeholder ?? (terse ? "Ask anything" : "Ask anything, @ to mention, / for commands");
  const expanded = suggestions.state === "ready";

  return (
    <div ref={box} className="relative">
      {suggestions.state !== "closed" && (
        <Suspense fallback={null}>
          <DeferredSuggestionList.Component
            id={listId}
            suggestions={suggestions}
            active={active}
            onPick={pick}
          />
        </Suspense>
      )}
      <div
        data-slot="composer"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          attachments.add(event.dataTransfer.files);
        }}
        className={cn(
          "glass flex flex-col rounded-xl transition-[box-shadow,border-color] duration-(--dur-2)",
          "focus-within:border-[color-mix(in_oklab,var(--foreground)_22%,var(--glass-border))] focus-within:shadow-[var(--glass-highlight),0_0_0_0.5px_var(--glass-edge),var(--glass-shadow),0_0_0_4px_color-mix(in_oklab,var(--foreground)_6%,transparent)]",
        )}
      >
        <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
        <textarea
          ref={input}
          rows={1}
          value={text}
          readOnly={sending}
          autoFocus={props.autoFocus}
          aria-label="Message"
          placeholder={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
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
          className="block min-h-11 w-full resize-none overflow-y-auto bg-transparent px-4 py-3 text-[14px] leading-5 text-foreground outline-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap placeholder:text-subtle-foreground"
        />
        {/* Clicking the footer's empty space writes in the message, as the input's own area does. */}
        <div
          data-slot="composer-footer"
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            input.current?.focus();
          }}
          className="mb-1 flex h-10 items-center gap-2 px-2"
        >
          <AddButton
            reasons={{
              files: unscoped,
              images: unscoped ?? props.imagesUnavailable,
              mention: unscoped,
              command: text.trim() ? "Commands go at the start of an empty message" : undefined,
            }}
            recent={() => recentFiles(storage, props.thread.workspaceId)}
            focusTarget={input}
            onFiles={attachments.add}
            onMention={() => edit(insertAt(text, caret, "@"))}
            onCommand={() => edit({ text: "/", caret: 1 })}
            onRecent={(path) => {
              mention(path);
              edit(insertAt(text, caret, `@${path} `));
            }}
          />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ComposerCompact value={compact}>{props.controls}</ComposerCompact>
          </div>
          {props.status}
          <PrimaryAction
            mode={mode}
            blocked={blocked}
            onSend={() => void submit(false)}
            onStop={() => props.onStop?.()}
          />
        </div>
      </div>
    </div>
  );
}
