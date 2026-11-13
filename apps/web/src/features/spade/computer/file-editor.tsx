import { formatBytes } from "@ace/ui-core/byte-size";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { DisabledReason } from "@/components/ui/disabled-reason.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { message } from "../spade-screen-parts.tsx";
import { useSpadeClient, useSpadeMachine } from "../spade-machine.tsx";
import { readFile } from "../spade-workspace-api.ts";
import { changedSinceOpened, saveFile } from "./computer-api.ts";

/** Why a change to the bot's files can't be made now: the computer is changing hands. */
export const notNowToChange = "Files can change once the computer is yours or shared again";

/**
 * A file of the bot's open: a text file to edit in place whenever the person may act (cowork, or
 * exclusive while they drive), Save once it changed (⌘S too). A save carries the revision the
 * person opened; when the bot (or anything) changed the file since, nothing is written and it says
 * "Changed since you opened it" with Reload (their draft goes, the file as it is now shows) and
 * Overwrite (their draft is saved over it). A file that isn't text, or is too large, says so with
 * Download. Download and Delete stay beside it.
 */
export function FileEditor(props: {
  bot: string;
  path: string;
  /** The person may act: the file can be edited and saved. */
  writable: boolean;
  /** Whether a change may go right now, said again just before saving. */
  mayWrite(): boolean;
  onDownload(): void;
  onDelete(): void;
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
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  /** The last save was refused: the file changed since it was opened. */
  const [conflict, setConflict] = useState(false);
  const text = file.data?.text;
  const changed = draft !== undefined && draft !== text;
  const reason = props.writable ? undefined : notNowToChange;
  /** Saves the draft over the revision `opened` (the one shown, unless Overwrite read anew). */
  const save = (opened = file.data?.revision) => {
    if (draft === undefined || (!changed && !conflict) || saving || !props.mayWrite()) return;
    setSaving(true);
    const sent = draft;
    void saveFile(client, props.bot, props.path, sent, opened).then(
      () => {
        setSaving(false);
        setConflict(false);
        // Until the read below says the new revision, nothing later is saved over another.
        cache.setQueryData(key, { ...file.data, text: sent, size: sent.length });
        // Words typed while it saved stay as the draft; only what was saved is done.
        setDraft((now) => (now === sent ? undefined : now));
        void cache.invalidateQueries({ queryKey: ["spade", "workspace", machine.key, props.bot] });
      },
      (error: unknown) => {
        setSaving(false);
        if (changedSinceOpened(error)) setConflict(true);
        else toast.error({ title: `Couldn't save ${props.path}`, description: message(error) });
      },
    );
  };
  /** The file as it is now; the draft goes. */
  const reload = () => {
    setConflict(false);
    setDraft(undefined);
    void file.refetch();
  };
  /** The draft, saved over the file as it is now. */
  const overwrite = () => {
    void file.refetch().then((now) => {
      if (now.data) save(now.data.revision);
    });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        {text !== undefined && (
          <DisabledReason reason={reason}>
            <Button
              size="xs"
              variant={changed ? "primary" : "ghost"}
              disabled={!changed || saving || !props.writable}
              onClick={() => save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </DisabledReason>
        )}
        <Button size="xs" variant="ghost" onClick={props.onDownload}>
          Download
        </Button>
        <DisabledReason reason={reason}>
          <Button size="xs" variant="ghost" disabled={!props.writable} onClick={props.onDelete}>
            Delete
          </Button>
        </DisabledReason>
        {file.data && (
          <span className="ml-auto pr-2 text-meta text-muted-foreground tabular-nums">
            {formatBytes(file.data.size)}
          </span>
        )}
      </div>
      {conflict && (
        <div role="alert" className="flex shrink-0 items-center gap-1 px-4 pb-2">
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
      {file.isPending ? (
        <LoadingRegion label="File" className="px-4">
          <Skeleton className="h-40 w-full rounded-md" />
        </LoadingRegion>
      ) : file.isError ? (
        <p role="alert" className="px-4 text-ui text-muted-foreground">
          {message(file.error)}
        </p>
      ) : text === undefined ? (
        <p className="px-4 text-ui text-muted-foreground">
          {file.data.unreadable === "too_large"
            ? "Too large to edit here. Download it to open it."
            : "This file isn't text. Download it to open it."}
        </p>
      ) : (
        <textarea
          aria-label={props.path}
          readOnly={!props.writable}
          spellCheck={false}
          value={draft ?? text}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              save();
            }
          }}
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-2 font-mono text-xs leading-normal text-foreground outline-none"
        />
      )}
    </div>
  );
}
