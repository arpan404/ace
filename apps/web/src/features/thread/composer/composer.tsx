import type { Mention } from "@ace/protocol";
import type { ComposerDraft } from "@ace/ui-core";
import {
  Suspense,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { ThreadRef } from "../sources/index.ts";
import { AddButton } from "./add-button.tsx";
import { AttachmentChips, useAttachments } from "./attachments.tsx";
import { ComposerCompact } from "./composer-compact.ts";
import { accept, insertAt, mentionsIn, triggerAt, type Trigger } from "./draft.ts";
import { readDraft, recentFiles, rememberFile, writeDraft } from "./draft-store.ts";
import { PrimaryAction } from "./primary-action.tsx";
import { DeferredSuggestionList } from "./deferred-parts.tsx";
import type { LocalAttachment } from "./send-store.ts";
import { takeDraftsFor, type ReturnedDraft } from "./send-store.ts";
import { useSuggestions, type Suggestion } from "./suggestions.tsx";
import { useAutosize } from "./use-autosize.ts";
import { useDraftPersistence } from "./use-draft-persistence.ts";
import { useTypeToFocus } from "./use-type-to-focus.ts";

/** What other parts of the thread screen may ask of its composer. */
export interface ComposerHandle {
  /** Open the + menu (files, images, a mention, a page) over the composer. */
  openAdd(): void;
  /** Put the caret in the message. */
  focus(): void;
}

export interface Draft {
  text: string;
  mentions: Mention[];
  attachments: { sha256: string }[];
  /** The files as this window knows them (names, types, previews), for the pending bubble. */
  local: LocalAttachment[];
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
 * a leading `/` completes commands, and paste or drop attach files. Enter empties it at once:
 * the message shows as its bubble straight away (UX audit SY-2) and comes back here only if
 * this device couldn't even save it. The unsent draft is kept per `draftKey` across navigation,
 * reloads and windows.
 */
export function Composer({
  ref,
  ...props
}: {
  thread: ThreadRef;
  /** Where this device keeps the unsent draft; without one it lives only while mounted. */
  draftKey?: string | undefined;
  /** Uploaded files outlive a reload only where the daemon keeps them: an existing thread. */
  keepsAttachments?: boolean | undefined;
  /** The agent is busy: an empty composer offers Stop and a message follows up. */
  busy: boolean;
  /** What Enter does with a follow-up while busy; ⌘↵ does the other. Defaults to queue. */
  followUp?: "queue" | "steer" | undefined;
  /** ⌘↵ does the other follow-up; false when the provider can't steer (both queue). */
  canSteer?: boolean | undefined;
  /**
   * Take the message. Resolves false when this device couldn't save it: the composer puts it
   * back if nothing new was typed meanwhile.
   */
  onSubmit(draft: Draft): Promise<boolean>;
  onStop?: (() => void) | undefined;
  /** A Stop is on its way: the button says so until the turn ends. */
  stopping?: boolean | undefined;
  /** Edit on a failed message brought back the effort and speed it was sent with. */
  onReturnedOptions?: ((options: ReturnedDraft["options"]) => void) | undefined;
  /** Footer controls after +, e.g. approvals and the model; they read `useComposerCompact()`. */
  controls?: ReactNode;
  /** Right of the controls, before the primary action, e.g. the context meter. */
  status?: ReactNode;
  /** Why images can't be added, when the provider doesn't read them. */
  imagesUnavailable?: string | undefined;
  placeholder?: string | undefined;
  autoFocus?: boolean | undefined;
  /** Printable keys typed on the page (not in a field, menu or dialog) write here. */
  typeToFocus?: boolean | undefined;
  /** The input's accessible name; "Message" by default. */
  label?: string | undefined;
  /**
   * Why nothing can be sent here at all (a side chat the daemon can't run): the composer keeps
   * its shape, but its input and actions are off and point at the reason.
   */
  unavailable?:
    | {
        reason: string;
        describedBy: string;
        /** The reason in a few words, shown as the placeholder ("Side chats need a newer daemon"). */
        short?: string | undefined;
      }
    | undefined;
  ref?: Ref<ComposerHandle> | undefined;
}) {
  // A failed message brought back with its files remounts the composer on the restored draft.
  const [generation, setGeneration] = useState(0);
  return (
    <ComposerBody
      key={generation}
      {...props}
      ref={ref}
      onReplaced={() => setGeneration((value) => value + 1)}
    />
  );
}

function ComposerBody({ ref, ...props }: Parameters<typeof Composer>[0] & { onReplaced(): void }) {
  // Kept out of the compiler, as it was before: memoizing every handler here costs the
  // thread route ~5 KB of code for a component that re-renders per keystroke anyway.
  "use no memo";
  const { storage } = useLayout();
  const [restored] = useState(() =>
    props.draftKey ? readDraft(storage, props.draftKey) : undefined,
  );
  const [text, setText] = useState(restored?.text ?? "");
  const [caret, setCaret] = useState(text.length);
  const [dismissed, setDismissed] = useState<number>();
  const [highlight, setActive] = useState({ key: "", index: 0 });
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(restored?.mentions));
  // A newer version of this draft written in another window, while this one has focus.
  const [theirs, setTheirs] = useState<ComposerDraft>();
  // Where to put the caret once an inserted suggestion has rendered.
  const placeCaret = useRef<number | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const addMenu = useRef<{ open(): void }>(null);
  useImperativeHandle(ref, () => ({
    openAdd: () => addMenu.current?.open(),
    focus: () => input.current?.focus(),
  }));
  const attachments = useAttachments(
    props.thread,
    props.keepsAttachments ? restored?.attachments : undefined,
  );
  const found = triggerAt(text, caret);
  const trigger: Trigger | undefined = found && found.start !== dismissed ? found : undefined;
  const suggestions = useSuggestions(props.thread, trigger, () =>
    recentFiles(storage, props.thread.workspaceId),
  );
  const items = suggestions.state === "ready" ? suggestions.items : [];
  // The highlight resets whenever the token being completed changes.
  const listKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : "";
  const active = highlight.key === listKey ? highlight.index : 0;
  const empty = !text.trim() && !attachments.items.length;
  const compact = width > 0 && width < compactWidth;
  const terse = width > 0 && width < terseWidth;

  const current: ComposerDraft = {
    text,
    mentions: [...picked],
    attachments: props.keepsAttachments ? attachments.ready : [],
  };
  const apply = (next: ComposerDraft) => {
    setTheirs(undefined);
    setText(next.text);
    setCaret(next.text.length);
    setPicked(new Set(next.mentions));
  };
  const saved = useDraftPersistence(props.draftKey, current, (next) => {
    // Another window changed this draft: an idle composer takes it, a focused one offers it.
    if (document.activeElement === input.current) setTheirs(next ?? emptyDraft);
    else apply(next ?? emptyDraft);
  });
  // Edit on a failed message: its text joins what's here, its files and picks come back.
  const draftKey = props.draftKey;
  const takeReturned = useEffectEvent((returned: ReturnedDraft) => {
    if (!draftKey) return;
    saved.discard();
    writeDraft(storage, draftKey, {
      text: text.trim() ? `${text.trimEnd()}\n\n${returned.text}` : returned.text,
      mentions: [...new Set([...picked, ...returned.mentions])],
      attachments: [...current.attachments, ...returned.attachments],
    });
    props.onReturnedOptions?.(returned.options);
    props.onReplaced();
  });
  useEffect(() => {
    if (!draftKey) return;
    return takeDraftsFor(draftKey, (returned) => takeReturned(returned));
  }, [draftKey]);
  // Whether anything was typed since a message left (for one that has to come back).
  const typed = useRef("");
  useLayoutEffect(() => {
    typed.current = text;
  }, [text]);
  useAutosize(input, text, width);
  useTypeToFocus(input, !!props.typeToFocus && !props.unavailable);
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
  const off = props.unavailable?.reason;
  const failedUpload = attachments.items.some((item) => item.state === "failed");
  const blocked = off
    ? off
    : attachments.uploading
      ? "Waiting for the files to upload"
      : failedUpload
        ? "Remove the file that didn't upload first"
        : empty
          ? "Write a message first"
          : undefined;
  // Enter empties the composer at once; the message is the parent's from here on. Only a
  // message this device couldn't save comes back, and only into an untouched composer.
  const submit = (opposite: boolean) => {
    if (blocked) return;
    const draft: Draft = {
      text: text.trim(),
      mentions: mentionsIn(text, picked),
      attachments: attachments.ready.map((file) => ({ sha256: file.sha256 })),
      local: attachments.items.map((file) => ({
        sha256: file.sha256,
        name: file.name,
        mimeType: file.preview ? "image/*" : "application/octet-stream",
        bytes: 0,
        previewUrl: undefined,
      })),
      opposite,
    };
    const before = { text, picked, files: attachments.ready };
    saved.discard();
    setText("");
    setCaret(0);
    setTheirs(undefined);
    attachments.clear();
    setPicked(new Set());
    void props.onSubmit(draft).then((sent) => {
      if (sent || !draftKey || typed.current.trim()) return;
      // Couldn't be saved: back in the composer, files included (a remount restores them).
      writeDraft(storage, draftKey, {
        text: before.text,
        mentions: [...before.picked],
        attachments: before.files,
      });
      props.onReplaced();
    });
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
      submit((event.metaKey || event.ctrlKey) && props.canSteer !== false);
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
    props.unavailable?.short ??
    props.placeholder ??
    (terse ? "Ask anything" : "Ask anything, @ to mention, / for commands");
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
      {theirs && (
        <p className="mb-1.5 px-2 text-xs text-subtle-foreground">
          Edited in another window ·{" "}
          <button
            type="button"
            className="font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => apply(theirs)}
          >
            Use that version
          </button>
        </p>
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
          // Typing keeps the shell calm: a slightly firmer edge and a faint halo, nothing louder;
          // the footer's controls carry their own focus-visible rings.
          "focus-within:border-[color-mix(in_oklab,var(--foreground)_14%,var(--glass-border))] focus-within:shadow-[var(--glass-highlight),0_0_0_0.5px_var(--glass-edge),var(--glass-shadow),0_0_0_4px_color-mix(in_oklab,var(--foreground)_4%,transparent)]",
        )}
      >
        <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
        <textarea
          ref={input}
          rows={1}
          value={text}
          disabled={!!off}
          aria-describedby={props.unavailable?.describedBy}
          autoFocus={props.autoFocus}
          aria-label={props.label ?? "Message"}
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
          className="block min-h-11 w-full resize-none overflow-y-auto bg-transparent px-4 py-3 text-base leading-5 text-foreground outline-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap placeholder:text-subtle-foreground disabled:cursor-not-allowed"
        />
        {/* Clicking the footer's empty space writes in the message, as the input's own area does. */}
        <div
          data-slot="composer-footer"
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            input.current?.focus();
          }}
          className="mb-1 flex h-10 items-center gap-1 px-2"
        >
          <AddButton
            handle={addMenu}
            reasons={{
              files: off ?? unscoped,
              images: off ?? unscoped ?? props.imagesUnavailable,
              mention: off ?? unscoped,
              command:
                off ?? (text.trim() ? "Commands go at the start of an empty message" : undefined),
            }}
            focusTarget={input}
            onFiles={attachments.add}
            onMention={() => edit(insertAt(text, caret, "@"))}
            onCommand={() => edit({ text: "/", caret: 1 })}
            onInsert={(inserted) => edit(insertAt(text, caret, inserted))}
            thread={props.thread.draft ? undefined : props.thread}
            unavailable={props.unavailable}
          />
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <ComposerCompact value={compact}>{props.controls}</ComposerCompact>
          </div>
          {props.status}
          <PrimaryAction
            mode={mode}
            blocked={blocked}
            off={!!off}
            canSteer={props.canSteer !== false}
            stopping={!!props.stopping}
            describedBy={props.unavailable?.describedBy}
            onSend={() => submit(false)}
            onStop={() => props.onStop?.()}
          />
        </div>
      </div>
    </div>
  );
}

const emptyDraft: ComposerDraft = { text: "", mentions: [], attachments: [] };
