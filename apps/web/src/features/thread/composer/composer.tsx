import { FloatingContents } from "@/components/ui/floating-material.tsx";
import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import type { ComposerDraft } from "@ace/ui-core";
import { useId, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { useHandheld } from "@/lib/breakpoints.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { AddHandle } from "./add-button.tsx";
import { AttachmentChips, maxAttachmentsPerMessage, useAttachments } from "./attachments.tsx";
import { ComposerCompact } from "./composer-compact.ts";
import { ComposerFooter } from "./composer-footer.tsx";
import { composerKeyDown } from "./composer-keys.ts";
import { ComposerNotices } from "./composer-notices.tsx";
import { ComposerOverlays } from "./composer-overlays.tsx";
import { pasteIntoComposer, sendBlockedReason } from "./composer-paste.ts";
import type { ComposerProps } from "./composer-props.ts";
import { composerSurface, inputLine, inputMinLines } from "./composer-styles.ts";
import type { Trigger } from "./draft.ts";
import { readDraft, recentFiles, rememberFile, writeDraft } from "./draft-store.ts";
import { carriesFiles, takeTransfer, type Intake } from "./file-intake.ts";
import { MessageInput } from "./message-input.tsx";
import { matchesSubmittedDraft } from "./submitted-draft.ts";
import type { Suggestion } from "./suggestions.tsx";
import { useAutosize } from "./use-autosize.ts";
import { useComposerPicks } from "./use-composer-picks.ts";
import { useComposerSubmit } from "./use-composer-submit.ts";
import { useComposerSuggestions } from "./use-composer-suggestions.ts";
import { useDraftSync } from "./use-draft-sync.ts";
import { useElementWidth } from "./use-element-width.ts";
import { useMessageState } from "./use-message-state.ts";
import { useStableHandlers } from "./use-stable-handlers.ts";
import { useTypeToFocus } from "./use-type-to-focus.ts";

export type { Draft } from "./draft.ts";
export type { ComposerHandle } from "./composer-props.ts";

/**
 * The composer's own width (not the window's) shapes it. Below `compact` the footer drops
 * labels to icons and the hint shortens, keeping both rows and every control; only below `pill`,
 * on a phone or touch screen, may an empty composer fold into one row.
 */
const compactWidth = 640;
const pillWidth = 480;

const emptyDraft: ComposerDraft = { text: "", mentions: [], attachments: [] };

/**
 * The composer: an input area above a footer, inside one rounded surface, at every width and
 * line count (SPEC "Composer"). Text keeps one inset from empty to many lines and grows upward a
 * line at a time up to seven visible lines. The action row keeps + and approvals on the left
 * and model/effort, Stop and send on the right. The one strip (`attached`) sits behind its top
 * edge; nothing sits below it. + opens the Add menu, `@` completes files, a leading `/`
 * completes commands, and paste or drop attach files. Enter empties it at once: the message
 * shows as its bubble straight away (UX audit SY-2) and comes back here only if this device
 * couldn't even save it. The unsent draft is kept per `draftKey` across navigation, reloads and
 * windows.
 */
function ComposerContent({ ref, ...props }: ComposerProps) {
  // A failed message brought back with its files remounts the composer on the restored draft.
  const [generation, setGeneration] = useState(0);
  const [replacedDraft, setReplacedDraft] = useState<ComposerDraft>();
  return (
    <ComposerBody
      key={generation}
      {...props}
      ref={ref}
      replacedDraft={replacedDraft}
      onReplaced={(draft) => {
        setReplacedDraft(draft);
        setGeneration((value) => value + 1);
      }}
    />
  );
}

function ComposerBody({
  ref,
  ...props
}: ComposerProps & {
  replacedDraft?: ComposerDraft | undefined;
  onReplaced(draft?: ComposerDraft): void;
}) {
  // Kept out of the compiler: memoizing every handler here costs the thread route ~5 KB of
  // code. Typing re-renders this body; the footer is memoised and stays put.
  "use no memo";
  const { storage } = useLayout();
  const [restored] = useState(
    () => props.replacedDraft ?? (props.draftKey ? readDraft(storage, props.draftKey) : undefined),
  );
  const input = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const addMenu = useRef<AddHandle>(null);
  const listId = useId();
  const message = useMessageState(
    input,
    restored ?? { ...emptyDraft, text: props.initialText ?? "" },
  );
  const { text, tokens, caret } = message;
  const [showAttachments, setShowAttachments] = useState(false);
  const [argumentsFor, setArgumentsFor] = useState<{ item: Suggestion; trigger: Trigger }>();
  // What the last drop or paste couldn't attach in full (a large folder, too many files).
  const [notice, setNotice] = useState<string>();
  const width = useElementWidth(box);
  const handheld = useHandheld();
  const attachments = useAttachments(
    props.thread,
    props.replacedDraft?.attachments ??
      (props.keepsAttachments ? restored?.attachments : undefined),
  );
  const attach = (files: Iterable<File>, note?: string) => {
    const selected = [...files];
    const left = attachments.add(selected);
    if (selected.length > left) props.onFilesAdded?.();
    setNotice(
      left
        ? `A message carries up to ${maxAttachmentsPerMessage} files; ${left} more weren't attached.`
        : note,
    );
  };
  const intake = (data: DataTransfer) =>
    takeTransfer(data, (taken: Intake) => attach(taken.files, taken.note));
  const list = useComposerSuggestions(props.thread, text, caret, () =>
    recentFiles(storage, props.thread.workspaceId),
  );
  const { trigger, suggestions, items, active, adding, setAdding, setDismissed } = list;
  const empty = !text.trim() && !attachments.items.length;
  const compact = width > 0 && width < compactWidth;
  const current: ComposerDraft = {
    text,
    tokens,
    mentions: [...message.picked],
    attachments: props.keepsAttachments ? attachments.ready : [],
  };
  const sync = useDraftSync({
    draftKey: props.draftKey,
    storage,
    current,
    input,
    attachments,
    keepsAttachments: !!props.keepsAttachments,
    take: message.take,
    replace: props.onReplaced,
    onDraftChange: props.onDraftChange,
    ownsDraft: props.ownsDraft,
    onReturnedOptions: props.onReturnedOptions,
  });
  // An empty composer on a narrow phone is one pill row: + · message · model · send. A narrow
  // column on a desktop or tablet (a docked panel, say) keeps the full composer and approvals.
  const pill =
    handheld &&
    width > 0 &&
    width < pillWidth &&
    empty &&
    !props.unavailable &&
    suggestions.state === "closed";
  useAutosize(input, text, width, pill ? 1 : inputMinLines);
  useTypeToFocus(input, !!props.typeToFocus && !props.unavailable);
  const step = (direction: "undo" | "redo") => {
    const shown = message.step(direction);
    if (shown) list.dismissAt(shown.text, shown.caret);
  };
  // ↑ in an empty, idle composer brings the last sent message back to edit and send again.
  const recall = () => {
    const last = !text && !props.busy ? props.recall?.() : undefined;
    if (!last) return false;
    message.edit({ text: last, caret: last.length, tokens: [] });
    list.dismissAt(last, last.length);
    return true;
  };
  const clear = () => {
    sync.take(emptyDraft);
    setNotice(undefined);
  };
  useImperativeHandle(ref, () => ({
    openAdd: () => addMenu.current?.open(),
    focus: () => input.current?.focus(),
    takeFiles: intake,
    preserveDraft: (key) => writeDraft(storage, key, current),
    discardIfSubmitted(sent) {
      if (!matchesSubmittedDraft({ ...current, attachments: attachments.ready }, sent))
        return false;
      // The recovery owner already removed the matching persisted draft. Stop a stale
      // unmount flush from restoring it while leaving newer drafts untouched.
      sync.saved.drop();
      clear();
      attachments.clear();
      return true;
    },
  }));
  const { addToken, pick } = useComposerPicks({
    thread: props.thread,
    text,
    tokens,
    caret,
    trigger,
    adding,
    edit: message.edit,
    rememberMention: (path) => {
      message.remember(path);
      rememberFile(storage, props.thread.workspaceId, path);
    },
    setAdding,
    setDismissed,
    setNotice,
    showAttachments: () => setShowAttachments(true),
    askArguments: (item, at) => setArgumentsFor({ item, trigger: at }),
    closeArguments: () => setArgumentsFor(undefined),
    addMenu,
    box,
    onPlan: props.onPlan,
  });
  const off = props.unavailable?.reason;
  const blocked = sendBlockedReason({
    off,
    sendBlocked: props.sendBlocked?.reason,
    uploading: attachments.uploading,
    sendsWhileUploading: !!props.sendsWhileUploading,
    failedUpload: attachments.items.some((item) => item.state === "failed"),
    empty,
  });
  const submit = useComposerSubmit({
    blocked,
    current,
    entries: suggestions.entries,
    attachments,
    saved: sync.saved,
    draftKey: props.draftKey,
    storage,
    onSubmit: props.onSubmit,
    clear,
    takeText: sync.take,
    replace: props.onReplaced,
  });
  const canStop = props.busy && !!props.onStop;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    composerKeyDown(event, {
      list:
        trigger && suggestions.state !== "closed"
          ? {
              count: items.length,
              active,
              pending:
                trigger.kind === "command" &&
                (suggestions.state === "loading" || suggestions.state === "failed"),
              move: list.highlight,
              pick: () => {
                const item = items[active];
                if (item) pick(item);
              },
              dismiss: list.close,
            }
          : undefined,
      newline: message.newline,
      history: step,
      recall,
      stopKey: canStop && !props.stopping ? props.onStopKey : undefined,
      submit: (modified) => submit(modified && props.canSteer !== false),
    });
  // Busy, a message follows up (queued or steered) and Stop sits beside it; idle, it sends.
  const mode = props.busy ? (props.followUp === "steer" ? "steer" : "queue") : "send";
  const placeholder =
    props.unavailable?.short ??
    (compact ? (props.shortPlaceholder ?? props.placeholder) : props.placeholder) ??
    "Ask anything";
  const expanded = suggestions.state === "ready";
  // The footer's handlers keep one identity, so typing never re-renders it.
  const footer = useStableHandlers({
    onSend: () => submit(false),
    onStop: () => props.onStop?.(),
    onFiles: (files: FileList) => attach(files),
    onFocusInput: () => input.current?.focus(),
    onAddOpen: () => {
      setDismissed(undefined);
      setAdding(true);
      message.placeCaretAt(caret);
      input.current?.focus();
    },
  });

  return (
    <div ref={box} className="relative">
      <ComposerOverlays
        thread={props.thread}
        anchor={box}
        listId={listId}
        suggestions={suggestions}
        adding={adding}
        active={active}
        onHover={list.highlight}
        onPick={pick}
        onDismiss={list.close}
        showAttachments={showAttachments}
        onCloseAttachments={() => setShowAttachments(false)}
        argumentsFor={argumentsFor}
        onCloseArguments={() => {
          setArgumentsFor(undefined);
          input.current?.focus();
        }}
        onArguments={addToken}
      />
      <ComposerNotices
        theirs={sync.theirs}
        onUseTheirs={sync.apply}
        notice={notice}
        saveFailed={sync.saved.saveFailed}
      />
      <ComposerCompact value={compact}>
        {/* The composer and its strip are glass: popovers opened from them are solid. */}
        <FloatingContents glass>
          {props.attached}
          {props.environment}
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
            // The pill (see `pill`): typing or a file opens it; the same elements stay mounted,
            // so focus never moves.
            data-pill={pill ? "" : undefined}
            className={cn(composerSurface, "relative z-10 flex flex-col rounded-xl")}
          >
            <AttachmentChips
              items={attachments.items}
              onRemove={attachments.remove}
              onRetry={attachments.retry}
              threadId={props.thread.draft ? undefined : props.thread.id}
            />
            <div data-slot="composer-input" className="px-4 pt-3.5 pb-1.5">
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
                  message.type(next, at);
                  setDismissed(undefined);
                }}
                onCaret={message.setCaret}
                onHistory={step}
                onKeyDown={onKeyDown}
                onPaste={(event) =>
                  pasteIntoComposer(event, { input: input.current, intake, attach })
                }
                style={{ minHeight: inputLine * (pill ? 1 : inputMinLines) }}
                className="message-input block min-w-0 w-full overflow-y-auto bg-transparent p-0 text-base leading-5 whitespace-pre-wrap text-foreground outline-none"
              />
            </div>
            <ComposerFooter
              addMenu={addMenu}
              onFiles={footer.onFiles}
              onAddOpen={footer.onAddOpen}
              unavailable={props.unavailable}
              pill={pill}
              controls={props.controls}
              trailing={props.trailing}
              mode={mode}
              blocked={blocked}
              off={!!off}
              canSteer={props.canSteer !== false}
              describedBy={props.unavailable?.describedBy ?? props.sendBlocked?.describedBy}
              canStop={canStop}
              stopping={!!props.stopping}
              onSend={footer.onSend}
              onStop={footer.onStop}
              onFocusInput={footer.onFocusInput}
            />
          </div>
        </FloatingContents>
      </ComposerCompact>
    </div>
  );
}

export function Composer(props: ComposerProps) {
  return (
    <LocalBoundary key={props.draftKey ?? props.thread.id} label="the composer">
      <ComposerContent {...props} />
    </LocalBoundary>
  );
}
