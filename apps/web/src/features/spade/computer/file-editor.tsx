import { formatBytes } from "@ace/ui-core/byte-size";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { message } from "../spade-screen-parts.tsx";
import { useSpadeClient, useSpadeMachine } from "../spade-machine.tsx";
import { readFile } from "../spade-workspace-api.ts";
import { saveFile } from "./computer-api.ts";

/**
 * A file of the bot's open: a text file to edit in place, Save once it changed (⌘S too); a file
 * that isn't text, or is too large, says so with Download. Download and Delete stay beside it.
 */
export function FileEditor(props: {
  bot: string;
  path: string;
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
  const text = file.data?.text;
  const changed = draft !== undefined && draft !== text;
  const save = () => {
    if (!changed || saving) return;
    setSaving(true);
    void saveFile(client, props.bot, props.path, draft).then(
      () => {
        setSaving(false);
        cache.setQueryData(key, { ...file.data, text: draft, size: draft.length });
        setDraft(undefined);
        void cache.invalidateQueries({ queryKey: ["spade", "workspace", machine.key, props.bot] });
      },
      (error: unknown) => {
        setSaving(false);
        toast.error({ title: `Couldn't save ${props.path}`, description: message(error) });
      },
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        {text !== undefined && (
          <Button
            size="xs"
            variant={changed ? "primary" : "ghost"}
            disabled={!changed || saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={props.onDownload}>
          Download
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onDelete}>
          Delete
        </Button>
        {file.data && (
          <span className="ml-auto pr-2 text-meta text-muted-foreground tabular-nums">
            {formatBytes(file.data.size)}
          </span>
        )}
      </div>
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
