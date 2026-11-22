import { isMarkdownPath } from "@ace/ui-core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import "../spade-prose.css";
import { Button } from "@/components/ui/button.tsx";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { WordChoice } from "@/components/ui/word-choice.tsx";
import { CodeEditor, type EditorHandle } from "@/features/editor";
import { message } from "../spade-screen-parts.tsx";
import { useSpadeClient, useSpadeMachine } from "../spade-machine.tsx";
import { readFile } from "../spade-workspace-api.ts";
import { changedSinceOpened, saveFile } from "./computer-api.ts";
import { FileMediaView, mediaModeOf } from "./file-media-view.tsx";

/** Why a change to the bot's files can't be made now: the computer is changing hands. */
export const notNowToChange = "Files can change once the computer is yours or shared again";

/** What the person edits: their draft, and the file as it was when they began (its baseline). */
interface Edit {
  draft: string;
  /**
   * The text and revision the draft started from. Background reads of the file never move it;
   * a save does (to what it wrote, whose revision the next read of that same text tells).
   */
  baseline: { text: string; revision: string | undefined };
}

type MarkdownShow = "preview" | "source";
const markdownChoices = [
  { value: "preview", label: "Preview" },
  { value: "source", label: "Source" },
] as const;

/**
 * A file of the bot's open, in a well under the folder trail. Text opens in ace's code editor,
 * kept light: colours, find, undo and multiple carets, long lines wrapped to the panel, and none
 * of a checkout's chrome (no git marks, status line or pinned headers). Markdown opens rendered,
 * with Preview / Source to edit it. Pictures, PDFs, recordings and videos show in the browser's
 * own viewers; anything else says so with Download.
 *
 * Text is editable whenever the person may act (cowork, or exclusive while they drive): Save once
 * it changed (⌘S too). A save carries the revision the draft started from, never a newer one read
 * meanwhile; when the bot (or anything) changed the file since, nothing is written and it says
 * "Changed since you opened it" with Reload (their draft goes, the file as it is now shows) and
 * Overwrite (their draft is written whatever the file holds now). While the person has no draft,
 * a change the bot makes shows as it lands. Delete names the revision the person saw.
 */
export function FileEditor(props: {
  bot: string;
  path: string;
  /** The person may act: the file can be edited and saved. */
  writable: boolean;
  /** Whether a change may go right now, said again just before saving. */
  mayWrite(): boolean;
  onDownload(): void;
  /** Delete, refused if the file is no longer at `opened`, the revision the person saw. */
  onDelete(opened: string | undefined): void;
}) {
  const client = useSpadeClient();
  const machine = useSpadeMachine();
  const cache = useQueryClient();
  const toast = useToast();
  const key = ["spade", "workspace", machine.key, props.bot, "file", props.path];
  const file = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readFile(client, props.bot, props.path, { signal }),
  });
  const editor = useRef<EditorHandle>(null);
  const [edit, setEdit] = useState<Edit>();
  const [saving, setSaving] = useState(false);
  /** The last save was refused: the file changed since the draft began. */
  const [conflict, setConflict] = useState(false);
  const markdown = isMarkdownPath(props.path);
  const [show, setShow] = useState<MarkdownShow>("preview");
  const [wrap, setWrap] = useState(true);
  const text = file.data?.text;
  /**
   * The text the editor opened on, and its mount. With no draft, a new read of the file (the
   * bot wrote it) opens the editor again on it; a draft stays on show whatever is read meanwhile.
   */
  const [opened, setOpened] = useState<{ text?: string; mount: number }>({ mount: 0 });
  if (text !== undefined && edit === undefined && text !== opened.text)
    setOpened({ text, mount: opened.mount + 1 });
  const changed = edit !== undefined && edit.draft !== edit.baseline.text;
  const reason = props.writable ? undefined : notNowToChange;
  const saved = (sent: string) => {
    setSaving(false);
    setConflict(false);
    cache.setQueryData(key, { ...file.data, text: sent, size: sent.length, revision: undefined });
    // The editor already holds what was saved: it stays open, caret and scroll where they are.
    setOpened((now) => ({ text: sent, mount: now.mount }));
    // Words typed while it saved stay as the draft, now on top of what was saved.
    setEdit((now) =>
      !now || now.draft === sent
        ? undefined
        : { draft: now.draft, baseline: { text: sent, revision: undefined } },
    );
    void cache.invalidateQueries({ queryKey: ["spade", "workspace", machine.key, props.bot] });
  };
  const refused = (error: unknown) => {
    setSaving(false);
    if (changedSinceOpened(error)) setConflict(true);
    else toast.error({ title: `Couldn't save ${props.path}`, description: message(error) });
  };
  /**
   * The baseline's revision. After a save it is learned from a fresh read, and only if the file
   * still holds what was saved; otherwise the file moved on, which is a conflict.
   */
  const baseOf = async (baseline: Edit["baseline"]): Promise<string | undefined> => {
    if (baseline.revision !== undefined) return baseline.revision;
    const now = await readFile(client, props.bot, props.path);
    if (now.text !== baseline.text || now.revision === undefined) setConflict(true);
    return now.text === baseline.text ? now.revision : undefined;
  };
  /** Saves the draft, only over the revision it started from. */
  const save = () => {
    if (!edit || !changed || saving || !props.mayWrite()) return;
    setSaving(true);
    const sent = edit.draft;
    void baseOf(edit.baseline)
      .then((base) => {
        if (base === undefined) {
          setSaving(false);
          return;
        }
        // The base was read: ask again whether a change may go.
        if (!props.mayWrite()) {
          setSaving(false);
          return;
        }
        return saveFile(client, props.bot, props.path, sent, base).then(() => saved(sent));
      })
      .catch(refused);
  };
  /** The draft, written whatever the file holds now (no base). Kept if that fails. */
  const overwrite = () => {
    if (!edit || saving || !props.mayWrite()) return;
    setSaving(true);
    const sent = edit.draft;
    void saveFile(client, props.bot, props.path, sent, undefined).then(() => saved(sent), refused);
  };
  /** The file as it is now; the draft goes. */
  const reload = () => {
    setConflict(false);
    setEdit(undefined);
    setOpened((now) => ({ mount: now.mount + 1 }));
    void file.refetch();
  };
  /** The editor's text after an edit: the first one fixes the baseline, the file as opened. */
  const edited = () => {
    const draft = editor.current?.text();
    if (draft === undefined || opened.text === undefined) return;
    const baseline = { text: opened.text, revision: file.data?.revision };
    setEdit((now) => (now ? { ...now, draft } : { draft, baseline }));
  };
  const shown = edit?.draft ?? opened.text;
  const media =
    file.data && text === undefined ? mediaModeOf(props.path, file.data.size) : undefined;
  const notText = (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-ui text-muted-foreground">
        {file.data?.unreadable === "too_large"
          ? "Too large to show here."
          : "This file can't be shown here."}
      </p>
      <Button size="sm" variant="secondary" onClick={props.onDownload}>
        Download
      </Button>
    </div>
  );

  return (
    <div className="px-4 pt-3">
      <div className="flex h-[max(22rem,calc(100dvh-26rem))] min-h-0 flex-col overflow-hidden rounded-xl bg-chat-well shadow-[inset_0_0_0_1px_var(--border-soft)]">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border-soft pr-2 pl-2">
          {markdown && text !== undefined && (
            <WordChoice<MarkdownShow>
              label="Show Markdown as"
              value={show}
              options={markdownChoices}
              onValueChange={setShow}
              className="shrink-0 gap-0.5"
            />
          )}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {text !== undefined && (
              <DisabledReason reason={reason}>
                <Button
                  size="xs"
                  variant={changed ? "primary" : "ghost"}
                  disabled={!changed || saving || !props.writable}
                  onClick={save}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </DisabledReason>
            )}
            <Button size="xs" variant="ghost" onClick={props.onDownload}>
              Download
            </Button>
            <DisabledReason reason={reason}>
              <Button
                size="xs"
                variant="ghost"
                disabled={!props.writable}
                onClick={() => props.onDelete(edit?.baseline.revision ?? file.data?.revision)}
              >
                Delete
              </Button>
            </DisabledReason>
          </span>
        </div>
        {conflict && (
          <div
            role="alert"
            className="flex shrink-0 items-center gap-1 border-b border-border-soft py-1.5 pr-2 pl-4"
          >
            <p className="min-w-0 flex-1 truncate text-ui text-foreground">
              Changed since you opened it
            </p>
            <Button size="xs" variant="ghost" disabled={saving} onClick={reload}>
              Reload
            </Button>
            <Button size="xs" variant="ghost" disabled={saving} onClick={overwrite}>
              Overwrite
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {file.isPending ? (
            <LoadingRegion label="File" className="p-4">
              <Skeleton className="h-40 w-full rounded-md" />
            </LoadingRegion>
          ) : file.isError ? (
            <p role="alert" className="p-4 text-ui text-muted-foreground">
              {message(file.error)}
            </p>
          ) : shown === undefined ? (
            media ? (
              <FileMediaView
                bot={props.bot}
                path={props.path}
                mode={media}
                revision={file.data.revision}
                fallback={notText}
              />
            ) : (
              notText
            )
          ) : markdown && show === "preview" ? (
            <div
              role="region"
              aria-label={`Preview of ${props.path}`}
              className="h-full overflow-y-auto"
              tabIndex={-1}
            >
              <article className="px-5 py-4 text-md leading-[1.6]">
                <Prose text={shown} className="ace-spade-file" />
              </article>
            </div>
          ) : (
            <CodeEditor
              key={opened.mount}
              ref={editor}
              text={shown}
              path={props.path}
              label={`Source of ${props.path}`}
              readOnly={!props.writable}
              wrap={wrap}
              onToggleWrap={() => setWrap((now) => !now)}
              statusLine={false}
              stickyScroll={false}
              fontSize={12}
              lineHeight={20}
              onEdit={edited}
              onSave={save}
            />
          )}
        </div>
      </div>
    </div>
  );
}
