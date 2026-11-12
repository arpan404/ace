import "@/styles/composer-pill.css";
import "@/styles/composer-markdown.css";
import { FloatingContents } from "@/components/ui/floating-material.tsx";
import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { withMarkerHashes, type ComposerDraft } from "@ace/ui-core";
import {
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "@/lib/cn.ts";
import { keyboardEnv, useKeys } from "@/lib/keybindings.ts";
import { parseChord } from "@/lib/keymap.ts";
import { useHandheld } from "@/lib/breakpoints.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { AddHandle } from "./add-button.tsx";
import { AttachmentChips, maxAttachmentsPerMessage, useAttachments } from "./attachments.tsx";
import { ComposerCompact } from "./composer-compact.ts";
import { ComposerFooter } from "./composer-footer.tsx";
import { composerKeyDown } from "./composer-keys.ts";
import { ComposerNotices } from "./composer-notices.tsx";
import { ComposerOverlays } from "./composer-overlays.tsx";
import { dropTextIntoComposer, pasteIntoComposer, sendBlockedReason } from "./composer-paste.ts";
import type { ComposerProps } from "./composer-props.ts";
import { composerSurface, inputLine, inputMinLines } from "./composer-styles.ts";
import type { Trigger } from "./draft.ts";
import { readDraft, recentFiles, rememberFile, writeDraft } from "./draft-store.ts";
import { carriesFiles, takeTransfer, type Intake } from "./file-intake.ts";
import { linkMarkers } from "./marker-links.ts";
import { MessageInput } from "./message-input.tsx";
import { matchesSubmittedDraft } from "./submitted-draft.ts";
import type { Suggestion } from "./suggestions.tsx";
import { useAutosize } from "./use-autosize.ts";
import { useComposerPicks } from "./use-composer-picks.ts";
import { useComposerSubmit } from "./use-composer-submit.ts";
import { usePanelTextEdit, useSendAfterEdits } from "./panel-text-edit.ts";
import { useComposerSuggestions } from "./use-composer-suggestions.ts";
import { useDraftSync } from "./use-draft-sync.ts";
import { useElementWidth } from "./use-element-width.ts";
import { useMessageState } from "./use-message-state.ts";
import { useStableHandlers } from "./use-stable-handlers.ts";
import { useTypeToFocus } from "./use-type-to-focus.ts";
import { useComposerAnnotations } from "./use-composer-annotations.ts";
import { ReplyQuotes, useDraftQuotes } from "@/features/quotes/index.ts";
import { AnnotationChip, useAnnotationPort } from "@/features/annotations/index.ts";

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
 * waits in the strip above it until the daemon has it (UX audit SY-2) and comes back here only if this device
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
  // Menus open from the input itself, over any strip attached above it.
  const surface = useRef<HTMLDivElement>(null);
  const addMenu = useRef<AddHandle>(null);
  const listId = useId();
  const restoredFiles =
    props.replacedDraft?.attachments ??
    (props.keepsAttachments ? restored?.attachments : undefined);
  const attachments = useAttachments(props.thread, restoredFiles);
  const [initial] = useState(() =>
    restored
      ? linkMarkers(
          restored,
          (restoredFiles ?? []).map((file, index) => ({ key: -1 - index, sha256: file.sha256 })),
        )
      : { ...emptyDraft, text: props.initialText ?? "" },
  );
  // A file's marker taken out of the words takes the file away, as its chip's Remove does.
  const message = useMessageState(input, initial, (keys) => {
    for (const key of keys) attachments.remove(key);
  });
  const { text, tokens, caret } = message;
  // A file removed from its chip (or never held: a twin, a restored draft's missing upload)
  // takes its marker out of the words.
  useLayoutEffect(() => message.prune(new Set(attachments.items.map((item) => item.key))));
  const [showAttachments, setShowAttachments] = useState(false);
  const [argumentsFor, setArgumentsFor] = useState<{ item: Suggestion; trigger: Trigger }>();
  // What the last drop or paste couldn't attach in full (a large folder, too many files).
  const [notice, setNotice] = useState<string>();
  const width = useElementWidth(box);
  const handheld = useHandheld();
  const annotations = useComposerAnnotations(
    props.thread,
    props.replacedDraft?.annotations ?? restored?.annotations,
  );
  const quotes = useDraftQuotes({
    threadId: props.thread.draft ? undefined : props.thread.id,
    restored: props.replacedDraft?.quotes ?? restored?.quotes,
    focus: () => input.current?.focus(),
  });
  const attach = (files: Iterable<File>, note?: string) => {
    const selected = [...files];
    const { left, added } = attachments.add(selected);
    message.markFiles(added);
    if (selected.length > left) props.onFilesAdded?.();
    setNotice(
      left
        ? `A message carries up to ${maxAttachmentsPerMessage} files; ${left} more weren't attached.`
        : note,
    );
  };
  const intake = (data: DataTransfer) =>
    takeTransfer(data, (taken: Intake) => attach(taken.files, taken.note));
  const list = useComposerSuggestions(
    props.thread,
    text,
    caret,
    () => recentFiles(storage, props.thread.workspaceId),
    !!props.filesOnly,
  );
  const { trigger, suggestions, items, active, adding, setAdding, setDismissed } = list;
  const empty = !text.trim() && !attachments.items.length && !annotations.count && !quotes.count;
  const compact = width > 0 && width < compactWidth;
  const markerFiles = attachments.items.map((item) => ({
    key: item.key,
    sha256: item.state === "ready" ? item.sha256 : undefined,
  }));
  const current: ComposerDraft = {
    text,
    tokens: withMarkerHashes(tokens, markerFiles),
    mentions: [...message.picked],
    attachments: props.keepsAttachments ? attachments.ready : [],
    annotations: annotations.draft,
    quotes: quotes.draft,
  };
  const sync = useDraftSync({
    draftKey: props.draftKey,
    storage,
    current,
    input,
    attachments,
    keepsAttachments: !!props.keepsAttachments,
    take: message.take,
    link: (draft) => linkMarkers(draft, markerFiles),
    replace: props.onReplaced,
    takeAnnotations: annotations.replace,
    takeQuotes: quotes.replace,
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
  // The sent message ↑/↓ last put in the composer, and how many back it is.
  const recalled = useRef<{ older: number; text: string } | undefined>(undefined);
  const step = (direction: "undo" | "redo") => {
    const shown = message.step(direction);
    if (shown) list.dismissAt(shown.text, shown.caret);
  };
  // ↑ from an empty composer brings back the last sent message and each further ↑ the one before
  // it, whether or not the agent is working; ↓ walks forward and past the newest clears again.
  // Once the shown message is edited or the caret leaves its end, the arrows move the caret.
  const recall = (direction: "older" | "newer") => {
    if (!props.recall) return false;
    const shown = recalled.current;
    const walking = !!shown && shown.text === text && caret === text.length;
    if (!walking && text.trim()) return false;
    const older = (walking ? shown.older : -1) + (direction === "older" ? 1 : -1);
    if (older < -1) return false;
    const next = older === -1 ? "" : props.recall(older);
    // Past the oldest, ↑ stays on it rather than jumping the caret to the start.
    if (next === undefined) return walking;
    recalled.current = older === -1 ? undefined : { older, text: next };
    message.edit({ text: next, caret: next.length, tokens: [] });
    list.dismissAt(next, next.length);
    return true;
  };
  const clear = () => {
    sync.take(emptyDraft);
    setNotice(undefined);
  };
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
  // An edited copy takes its chip's place, and the message's marker follows it.
  const editFile = (key: number, edited: string) => {
    const copy = attachments.edit(key, edited);
    if (copy) message.rekey(key, copy.key, copy.name);
    return copy;
  };
  const panelEdit = usePanelTextEdit({
    scope: props.thread.id,
    keys: attachments.items.map((item) => item.key),
    commit: editFile,
  });
  const submitNow = useComposerSubmit({
    blocked,
    current,
    entries: suggestions.entries,
    attachments,
    annotations,
    quotes,
    saved: sync.saved,
    draftKey: props.draftKey,
    storage,
    onSubmit: props.onSubmit,
    clear,
    takeText: sync.take,
    replace: props.onReplaced,
  });
  const submit = useSendAfterEdits(panelEdit.flush, submitNow);
  useImperativeHandle(ref, () => ({
    openAdd: () => addMenu.current?.open(),
    focus: () => input.current?.focus(),
    insertText: (words) => {
      const gap = text && !/\s$/.test(text) ? " " : "";
      const next = `${text}${gap}${words}`;
      message.edit({ text: next, caret: next.length });
    },
    takeFiles: intake,
    submit: (opposite = false) => submit(opposite),
    preserveDraft: (key) => writeDraft(storage, key, current),
    discardIfSubmitted(sent) {
      if (!matchesSubmittedDraft({ ...current, attachments: attachments.ready }, sent))
        return false;
      // The recovery owner already removed the matching persisted draft. Stop a stale
      // unmount flush from restoring it while leaving newer drafts untouched.
      sync.saved.drop();
      clear();
      attachments.clear();
      annotations.replace(undefined);
      quotes.replace(undefined);
      return true;
    },
  }));
  // The Browser's annotate bar adds to the draft and presses Send through this.
  useAnnotationPort(props.thread.draft ? undefined : props.thread.id, annotations, () =>
    submit(false),
  );
  const canStop = props.busy && !!props.onStop;
  const otherKeys = useKeys(props.otherSend?.shortcut ?? "followUpOther");
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
      bold: message.bold,
      backspace: message.backspace,
      apple: keyboardEnv().apple,
      indent: message.indent,
      history: step,
      recall,
      stopKey: canStop && !props.stopping ? props.onStopKey : undefined,
      other: parseChord(otherKeys),
      // Without a follow-up to swap, the other key still sends where it has a meaning here.
      submit: (other) => submit(other && (!!props.otherSend || props.canSteer !== false)),
    });
  // A steer always goes in now, a running command included: the daemon interrupts it if needed.
  const mode =
    !props.busy || props.sendsNow ? "send" : props.followUp !== "steer" ? "queue" : "steer";
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
      // With nothing to suggest, + is the file picker itself.
      if (props.filesOnly) return addMenu.current?.attach();
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
        anchor={surface}
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
            ref={surface}
            data-slot="composer"
            onDragOver={(event) => {
              if (carriesFiles(event.dataTransfer)) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!carriesFiles(event.dataTransfer)) {
                dropTextIntoComposer(event, input.current);
                return;
              }
              event.preventDefault();
              intake(event.dataTransfer);
            }}
            // The pill (see `pill`): typing or a file opens it; the same elements stay mounted,
            // so focus never moves.
            data-pill={pill ? "" : undefined}
            className={cn(composerSurface, "relative z-10 flex flex-col rounded-xl")}
          >
            <AnnotationChip
              threadId={props.thread.draft ? undefined : props.thread.id}
              annotations={annotations}
            />
            <AttachmentChips
              items={attachments.items}
              onRemove={attachments.remove}
              onRetry={attachments.retry}
              onEdit={editFile}
              panelEdit={panelEdit}
              threadId={props.thread.draft ? undefined : props.thread.id}
            />
            <ReplyQuotes quotes={quotes} />
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
                onChange={(next, at, composing, shown) => {
                  message.type(next, at, composing, shown);
                  setDismissed(undefined);
                }}
                onCaret={message.setCaret}
                onHistory={step}
                onTypeText={message.typeText}
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
              otherKeys={otherKeys}
              otherHint={props.otherSend?.hint}
              describedBy={props.unavailable?.describedBy ?? props.sendBlocked?.describedBy}
              canStop={canStop && empty && !props.stopInStrip}
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
