import { receiveComposerMentions } from "@/lib/composer-insert.ts";
import { ThreadId, type CatalogMention } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useForkOpener } from "../transitions/fork-opener.ts";
import { MessageInput } from "./message-input.tsx";
import { editorSelection, placeEditorCaret } from "./editor-dom.ts";
import {
  composerInput,
  editComposerTokens,
  type ComposerToken,
  type AttachmentReader,
  type ComposerDraft,
} from "@ace/ui-core";
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
import { composerSurface } from "./composer-styles.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { ThreadRef } from "../sources/index.ts";
import { AddButton, type AddHandle } from "./add-button.tsx";
import { useShareMessage, type ComposerAnswer } from "./answer-slot.ts";
import { AttachmentChips, maxAttachmentsPerMessage, useAttachments } from "./attachments.tsx";
import { ComposerCompact } from "./composer-compact.ts";
import { accept, insertAt, mentionsIn, triggerAt, type Draft, type Trigger } from "./draft.ts";
import { readDraft, recentFiles, rememberFile, writeDraft } from "./draft-store.ts";
import { PrimaryAction } from "./primary-action.tsx";
import {
  DeferredCommandArguments,
  DeferredThreadAttachments,
  DeferredSuggestionList,
} from "./deferred-parts.tsx";
import { carriesFiles, takeTransfer, type Intake } from "./file-intake.ts";
import { takeDraftsFor, type ReturnedDraft } from "./send-store.ts";
import { mergeReturnedDraft } from "./returned-draft.ts";
import { useSuggestions, type Suggestion } from "./suggestions.tsx";
import { useAutosize } from "./use-autosize.ts";
import { useDraftPersistence } from "./use-draft-persistence.ts";
import { useTypeToFocus } from "./use-type-to-focus.ts";

export type { Draft } from "./draft.ts";

/** What other parts of the thread screen may ask of its composer. */
export interface ComposerHandle {
  /** Keep the current draft for the thread that replaces this provisional view. */
  preserveDraft(key: string): void;
  /** Open the + menu (files, images, a mention, a page) over the composer. */
  openAdd(): void;
  /** Put the caret in the message. */
  focus(): void;
  /** Attach what a drop or paste elsewhere on the screen carries; call it during the event. */
  takeFiles(data: DataTransfer): void;
}

/** Below this width the footer drops labels to icons; below `terse` the hint shortens. */
const compactWidth = 480;
const terseWidth = 640;

/**
 * The composer: an input area above a footer, inside one rounded surface, at every width and
 * line count (SPEC "Composer"). Text keeps one inset from empty to many lines and grows upward a
 * line at a time up to seven visible lines. The action row keeps + and approvals on
 * the left and model/effort beside send/stop on the right; branch context stays below.
 * A card the agent or the person opens
 * (`attached`) sits behind its top edge like the next card of a deck. + opens the Add menu, `@` completes files,
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
  /** A starting message when this draft has no saved text. */
  initialText?: string | undefined;
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
  /** Footer controls after +: the approvals icon. They read `useComposerCompact()`. */
  controls?: ReactNode;
  /** Model and effort controls in the attached bottom environment strip. */
  trailing?: ReactNode;
  /**
   * The tab attached to the composer (what the agents are doing, their plan, an
   * agent's question): drawn above it, narrower and tucked behind its top edge. It reads
   * `useComposerCompact()` too.
   */
  attached?: ReactNode;
  /** Quiet environment controls below the box, sharing its compact-width context. */
  environment?: ReactNode;
  /**
   * The question card above: while it asks, the primary action and Enter answer it ("Answer",
   * "Submit", "Next"), and where it takes a typed answer the message is that answer.
   */
  answer?: ComposerAnswer | undefined;
  /**
   * Provider/model information for the surrounding composer controls. Attachments always
   * have a daemon file-path fallback, including when native media input is unavailable.
   */
  reader?: AttachmentReader | undefined;
  /** Send may go while files upload: the message waits as its bubble until they're done. */
  sendsWhileUploading?: boolean | undefined;
  placeholder?: string | undefined;
  /** The placeholder on a narrow composer, where `placeholder` would be cut short. */
  shortPlaceholder?: string | undefined;
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
  /** Keep drafting and attachment controls available while only sending is blocked. */
  sendBlocked?: { reason: string; describedBy: string } | undefined;
  onPlan?: (() => void) | undefined;
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
  const client = useClient();
  const navigate = useNavigate();
  const workspace = useWorkspaceActions(props.thread.id);
  const fork = useForkOpener();
  const [restored] = useState(() =>
    props.draftKey ? readDraft(storage, props.draftKey) : undefined,
  );
  const [text, setText] = useState(restored?.text ?? props.initialText ?? "");
  const [tokens, setTokens] = useState<readonly ComposerToken[]>(restored?.tokens ?? []);
  const [showAttachments, setShowAttachments] = useState(false);
  const [argumentsFor, setArgumentsFor] = useState<{ item: Suggestion; trigger: Trigger }>();
  const [caret, setCaret] = useState(text.length);
  const [dismissed, setDismissed] = useState<number>();
  const [highlight, setActive] = useState({ key: "", index: 0 });
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(restored?.mentions));
  // A newer version of this draft written in another window, while this one has focus.
  const [theirs, setTheirs] = useState<ComposerDraft>();
  // What the last drop or paste couldn't attach in full (a large folder, too many files).
  const [notice, setNotice] = useState<string>();
  // Where to put the caret once an inserted suggestion has rendered.
  const placeCaret = useRef<number | undefined>(undefined);
  const input = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const addMenu = useRef<AddHandle>(null);
  const attachments = useAttachments(
    props.thread,
    props.keepsAttachments ? restored?.attachments : undefined,
  );
  const attach = (files: Iterable<File>, note?: string) => {
    const left = attachments.add(files);
    setNotice(
      left
        ? `A message carries up to ${maxAttachmentsPerMessage} files; ${left} more weren't attached.`
        : note,
    );
  };
  const intake = (data: DataTransfer) =>
    takeTransfer(data, (taken: Intake) => attach(taken.files, taken.note));
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
    tokens,
    mentions: [...picked],
    attachments: props.keepsAttachments ? attachments.ready : [],
  };
  useImperativeHandle(ref, () => ({
    openAdd: () => addMenu.current?.open(),
    focus: () => input.current?.focus(),
    takeFiles: intake,
    preserveDraft: (key) => writeDraft(storage, key, current),
  }));
  // Another window's version of this draft is taken whole, its files too (SY-12). Files can't
  // be set in place, so a different set remounts the composer on the stored draft: theirs.
  const otherFiles = (next: ComposerDraft) => {
    return !!props.keepsAttachments && shas(next.attachments) !== shas(attachments.ready);
  };
  const takeText = (next: ComposerDraft) => {
    setTheirs(undefined);
    setText(next.text);
    setCaret(next.text.length);
    setPicked(new Set(next.mentions));
    setTokens(next.tokens ?? []);
  };
  const saved = useDraftPersistence(props.draftKey, current, (next) => {
    // Another window changed this draft: an idle composer takes it, a focused one offers it.
    const draft = next ?? emptyDraft;
    if (document.activeElement === input.current) return void setTheirs(draft);
    if (!otherFiles(draft)) return void takeText(draft);
    props.onReplaced();
    return "replace";
  });
  const apply = (next: ComposerDraft) => {
    if (!otherFiles(next)) return takeText(next);
    saved.drop();
    props.onReplaced();
  };
  // Edit on a failed message: its text joins what's here, its files and picks come back.
  const draftKey = props.draftKey;
  const takeReturned = useEffectEvent((returned: ReturnedDraft) => {
    if (!draftKey) return;
    saved.discard();
    writeDraft(storage, draftKey, mergeReturnedDraft(current, returned));
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
    placeEditorCaret(el, placeCaret.current);
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
    setTokens(editComposerTokens(text, next.text, tokens));
    setText(next.text);
    setCaret(next.caret);
    placeCaret.current = next.caret;
    input.current?.focus();
  };
  const rememberMention = (path: string) => {
    setPicked((paths) => new Set(paths).add(path));
    rememberFile(storage, props.thread.workspaceId, path);
  };
  const addToken = (
    item: Suggestion,
    at: Trigger,
    values?: NonNullable<CatalogMention["values"]>,
  ) => {
    const label = item.entry || item.threadId ? item.label : item.insert;
    const next = accept(text, at, label);
    const catalog: CatalogMention | undefined = item.entry
      ? {
          type: "mention",
          entryId: item.entry.id,
          name: item.entry.name,
          title: label,
          kind: item.entry.kind,
          ...(item.entry.icon ? { icon: item.entry.icon } : {}),
          arguments: "",
          ...(values ? { values } : {}),
        }
      : undefined;
    const token: ComposerToken = {
      start: at.start,
      end: at.start + label.length,
      label,
      ...(catalog ? { catalog } : {}),
      ...(item.path ? { file: { path: item.path } } : {}),
      ...(item.threadId
        ? {
            thread: {
              type: "thread_ref",
              threadId: ThreadId.parse(item.threadId),
              budgetBytes: 4096,
            },
          }
        : {}),
    };
    if (item.path) rememberMention(item.path);
    edit(next);
    setTokens(
      [...editComposerTokens(text, next.text, tokens), token].toSorted((a, b) => a.start - b.start),
    );
    setArgumentsFor(undefined);
  };
  const pick = (item: Suggestion) => {
    if (!trigger) return;
    if (
      tokens.length >= 64 ||
      (item.threadId && tokens.filter((token) => token.thread).length >= 8)
    ) {
      setNotice("This message has enough references. Remove one before adding another.");
      return;
    }
    const invocation = item.entry?.invocation;
    if (invocation?.type === "unavailable") {
      setNotice("This item isn't available for this provider. Choose another item.");
      return;
    }
    if (invocation?.type === "action") {
      const at = trigger;
      if (invocation.action === "attachments") {
        setShowAttachments(true);
        edit(accept(text, at, ""));
        return;
      }
      edit(accept(text, at, ""));
      setDismissed(at.start);
      void import("./actions.ts")
        .then(({ composerAction }) =>
          composerAction(invocation.action, {
            client,
            thread: props.thread,
            attach: () => addMenu.current?.attach(),
            files: () => {
              const next = accept(text, at, "@");
              edit({ ...next, caret: at.start + 1 });
              setDismissed(undefined);
            },
            project: () =>
              void navigate({ to: "/new", search: { project: props.thread.workspaceId } }),
            model: () =>
              box.current
                ?.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')
                ?.click(),
            review: () => workspace.open({ kind: "changes", id: "changes" }),
            fork: (point) => {
              if (fork) fork(point);
            },
            insert: (value) => edit(accept(text, at, value)),
            plan: props.onPlan,
          }),
        )
        .catch((error) =>
          setNotice(
            error instanceof Error
              ? error.message
              : "Couldn't use this action. Try again from the thread's menu.",
          ),
        );
      return;
    }
    if (invocation?.type === "prompt" && Object.keys(invocation.parameters ?? {}).length) {
      setArgumentsFor({ item, trigger });
      setDismissed(trigger.start);
      return;
    }
    addToken(item, trigger);
  };
  const insertMention = useEffectEvent((file: import("@ace/protocol").Mention) => {
    if (tokens.length >= 64) {
      setNotice("This message has enough references. Remove one before adding another.");
      return;
    }
    const label = `@${file.path}${file.lines ? `:${file.lines.start}-${file.lines.end}` : ""}`;
    const next = insertAt(text, caret, `${label} `);
    const start = next.caret - label.length - 1;
    edit(next);
    setTokens(
      [
        ...editComposerTokens(text, next.text, tokens),
        { start, end: start + label.length, label, file },
      ].toSorted((a, b) => a.start - b.start),
    );
    rememberMention(file.path);
  });
  useEffect(() => {
    if (props.thread.draft) return;
    return receiveComposerMentions(props.thread.id, (file) => insertMention(file));
  }, [props.thread.id, props.thread.draft]);
  const off = props.unavailable?.reason;
  const failedUpload = attachments.items.some((item) => item.state === "failed");
  const chips = attachments.items;
  const blocked =
    off || props.sendBlocked?.reason
      ? (off ?? props.sendBlocked?.reason)
      : attachments.uploading && !props.sendsWhileUploading
        ? "Waiting for the files to upload"
        : failedUpload
          ? "Remove the file that didn't upload first"
          : empty
            ? "Write a message first"
            : undefined;
  // Enter empties the composer at once; the message is the parent's from here on. Only a
  // message this device couldn't save comes back, and only into an untouched composer.
  // While a question asks, sending answers it; a message it can't take as its answer (a question
  // without free text) still goes as a message.
  const answer = props.answer && (empty || props.answer.invitesText) ? props.answer : undefined;
  // The composer is always in view; scrolling to it could drag the shell up mid-animation.
  useShareMessage(props.answer ? props.thread.id : undefined, !empty, () =>
    input.current?.focus({ preventScroll: true }),
  );
  const sendAnswer = () => {
    if (!answer || answer.blocked) return;
    answer.submit(text.trim());
    if (!answer.takesText) return;
    saved.discard();
    setText("");
    setTokens([]);
    setPicked(new Set());
    setCaret(0);
  };
  const submit = (opposite: boolean) => {
    if (blocked) return;
    const draft: Draft = {
      text,
      input: composerInput(text, tokens),
      threadRefs: tokens.flatMap((token) => (token.thread ? [token.thread] : [])),
      mentions: [
        ...mentionsIn(text, picked).filter(
          (mention) => !tokens.some((token) => token.file?.path === mention.path),
        ),
        ...tokens.flatMap((token) => (token.file ? [token.file] : [])),
      ].filter(
        (mention, index, all) =>
          all.findIndex(
            (other) =>
              other.path === mention.path &&
              JSON.stringify(other.lines) === JSON.stringify(mention.lines),
          ) === index,
      ),
      attachments: attachments.ready.map((file) => ({ sha256: file.sha256 })),
      files: {
        ...attachments.handOff(),
        uploading: attachments.items.filter((file) => file.state === "uploading").length,
      },
      opposite,
    };
    const before = { text, picked, tokens, files: attachments.ready };
    saved.discard();
    setText("");
    setCaret(0);
    setTheirs(undefined);
    setNotice(undefined);
    setPicked(new Set());
    setTokens([]);
    void props.onSubmit(draft).then((sent) => {
      if (sent || !draftKey || typed.current.trim()) return;
      // Couldn't be saved: back in the composer, files included (a remount restores them).
      writeDraft(storage, draftKey, {
        text: before.text,
        tokens: before.tokens,
        mentions: [...before.picked],
        attachments: before.files,
      });
      props.onReplaced();
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && event.shiftKey && input.current) {
      event.preventDefault();
      const range = editorSelection(input.current);
      edit({
        text: text.slice(0, range.start) + "\n" + text.slice(range.end),
        caret: range.start + 1,
      });
      return;
    }
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
      if (answer) return sendAnswer();
      submit((event.metaKey || event.ctrlKey) && props.canSteer !== false);
    }
  };
  // While a question asks, the composer answers it. Otherwise an empty composer offers what it
  // can do now: Stop, or (with nothing to send) Send, unavailable; a draft goes as a message,
  // queued or steered while the agent works.
  const mode = answer
    ? "answer"
    : empty
      ? props.busy && props.onStop
        ? "stop"
        : "send"
      : props.busy
        ? props.followUp === "steer"
          ? "steer"
          : "queue"
        : "send";
  const placeholder =
    props.unavailable?.short ??
    (answer?.invitesText ? "Type your answer" : undefined) ??
    (terse ? (props.shortPlaceholder ?? props.placeholder) : props.placeholder) ??
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
      {showAttachments && (
        <Suspense fallback={null}>
          <DeferredThreadAttachments.Component
            thread={props.thread}
            onClose={() => setShowAttachments(false)}
          />
        </Suspense>
      )}
      {argumentsFor?.item.entry && (
        <Suspense fallback={null}>
          <DeferredCommandArguments.Component
            entry={argumentsFor.item.entry}
            onClose={() => {
              setArgumentsFor(undefined);
              input.current?.focus();
            }}
            onAccept={(values) => addToken(argumentsFor.item, argumentsFor.trigger, values)}
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
      {notice && (
        <p role="status" className="mb-1.5 px-2 text-xs text-subtle-foreground">
          {notice}
        </p>
      )}
      <ComposerCompact value={compact}>
        {props.attached}
        <div
          data-slot="composer"
          onDragOver={(event) => {
            if (carriesFiles(event.dataTransfer)) event.preventDefault();
          }}
          onDrop={(event) => {
            if (!carriesFiles(event.dataTransfer)) return;
            event.preventDefault();
            intake(event.dataTransfer);
          }}
          className={cn(
            composerSurface,
            "relative z-10 flex flex-col rounded-xl transition-[box-shadow,border-color] duration-(--dur-2)",
            // Typing keeps the shell calm: a slightly firmer edge and a faint halo, nothing louder;
            // the footer's controls carry their own focus-visible rings.
            "focus-within:border-[color-mix(in_oklab,var(--foreground)_14%,var(--glass-border))] focus-within:shadow-[var(--glass-highlight),0_0_0_0.5px_var(--glass-edge),0_0_0_4px_color-mix(in_oklab,var(--foreground)_4%,transparent)]",
          )}
        >
          <AttachmentChips
            items={chips}
            onRemove={attachments.remove}
            onRetry={attachments.retry}
            threadId={props.thread.draft ? undefined : props.thread.id}
          />
          <MessageInput
            input={input}
            text={text}
            tokens={tokens}
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
            onChange={(next, at) => {
              setTokens(editComposerTokens(text, next, tokens));
              setText(next);
              setCaret(at);
              setDismissed(undefined);
            }}
            onCaret={setCaret}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              if (event.clipboardData.files.length) {
                event.preventDefault();
                intake(event.clipboardData);
                return;
              }
              event.preventDefault();
              const el = input.current;
              const selection = document.getSelection();
              if (!el || !selection?.rangeCount) return;
              const range = selection.getRangeAt(0);
              range.deleteContents();
              const node = document.createTextNode(event.clipboardData.getData("text/plain"));
              range.insertNode(node);
              range.setStartAfter(node);
              range.collapse(true);
              selection.removeAllRanges();
              selection.addRange(range);
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }}
            className="message-input block min-h-10 min-w-0 w-full overflow-y-auto bg-transparent px-4 pt-3.5 pb-1.5 text-base leading-5 whitespace-pre-wrap text-foreground outline-none"
          />
          {/* Clicking the footer's empty space writes in the message, as the input's own area does. */}
          <div
            data-slot="composer-footer"
            onMouseDown={(event) => {
              if (event.target !== event.currentTarget) return;
              event.preventDefault();
              input.current?.focus();
            }}
            className="mb-1.5 flex h-11 min-w-0 items-center justify-between gap-0.5 px-2"
          >
            <AddButton
              handle={addMenu}
              onFiles={attach}
              onOpen={() => {
                setDismissed(undefined);
                edit(insertAt(text, caret, "/"));
              }}
              unavailable={props.unavailable}
            />
            <div className="flex flex-1 items-center gap-0.5">{props.controls}</div>
            {props.trailing}
            <PrimaryAction
              mode={mode}
              blocked={blocked}
              off={!!off}
              canSteer={props.canSteer !== false}
              stopping={!!props.stopping}
              answer={answer}
              describedBy={props.unavailable?.describedBy ?? props.sendBlocked?.describedBy}
              onSend={() => (answer ? sendAnswer() : submit(false))}
              onStop={() => props.onStop?.()}
            />
          </div>
        </div>
        {props.environment}
      </ComposerCompact>
    </div>
  );
}

const emptyDraft: ComposerDraft = { text: "", mentions: [], attachments: [] };

/** A list of files by what they are, to compare two drafts' files. */
const shas = (list: readonly { sha256: string }[]) => list.map((file) => file.sha256).join();
