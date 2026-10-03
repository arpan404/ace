import { useClient, useThreadMeta } from "@ace/client-react";
import { ArrowElbowDownLeftIcon, GitDiffIcon } from "@phosphor-icons/react";
import { useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { LongRows, VirtualRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { countChanges, type FileDiff } from "@ace/ui-core";
import { DiffStat } from "./diff-stat.tsx";
import { WorkingTree } from "./working-tree.tsx";
import { discardDraft, draftKey, saveDraft, sendDrafts, type ReviewDraft } from "./drafts.ts";
import {
  FileDiffBlock,
  fileHeight,
  freshView,
  type FileView,
  type LineTarget,
} from "./file-diff.tsx";
import { CommentComposer, DraftCard } from "./line-comment.tsx";
import { useFileDiffs } from "@/lib/diffs/use-file-diffs.ts";
import { useTurns } from "./use-turns.ts";

const all = "all";
/** Past this many rows across the files shown, only the files near the viewport mount. */
const virtualRowsAbove = 2_000;
/** Past this many files, the list of changed files mounts only the entries near the viewport. */
const listAbove = 200;

/**
 * Changes tab: what the agents changed, turn by turn, with line comments that go back to the
 * agent through review mode.
 */
export function ChangesTab(props: { threadId: string }) {
  const { threadId } = props;
  const services = usePanelServices();
  const client = useClient();
  const thread = useThreadMeta(threadId);
  const turns = useTurns(threadId);
  const edited = useMemo(() => turns.filter((turn) => turn.edits.length), [turns]);
  const [picked, setPicked] = useState<string>();
  const prefs = useLocal(services.diffPrefs, identity);
  const allDrafts = useLocal(services.drafts, identity);
  const drafts = useMemo(
    () => allDrafts.filter((draft) => draft.threadId === threadId),
    [allDrafts, threadId],
  );
  const [composing, setComposing] = useState<{ file: string; target: LineTarget }>();
  // Per file, by path: kept here so a file scrolled out of a long list and back keeps it.
  const [views, setViews] = useState<ReadonlyMap<string, FileView>>(() => new Map());
  const viewOf = (path: string) => views.get(path) ?? freshView;
  const blocks = useRef<VirtualRowsHandle>(null);
  const anchor = useId();

  // Default to the latest turn that edited something; "All turns" shows the whole thread.
  const current =
    picked === all ? undefined : (edited.find((turn) => turn.id === picked) ?? edited.at(-1));
  const shown = useMemo(
    () => (current ? current.edits : edited.flatMap((turn) => turn.edits)),
    [current, edited],
  );
  const { files, pending } = useFileDiffs(shown);
  const stat = useMemo(() => countChanges(files.flatMap((file) => file.rows)), [files]);
  const rows = files.reduce((sum, file) => sum + file.rows.length, 0);
  const unsent = drafts.filter((draft) => draft.state === "draft" || draft.state === "failed");

  if (!edited.length)
    return (
      <EmptyState
        icon={GitDiffIcon}
        title="No changes yet"
        description="Edits the agents make in this thread show up here, turn by turn."
      />
    );

  const send = (keys: readonly string[]) => {
    if (thread) void sendDrafts(client, services.drafts, thread, keys);
  };
  const options = [
    { value: all, label: "All turns" },
    ...edited.map((turn) => ({ value: turn.id, label: `Turn ${turn.number}` })),
  ];
  const renderFile = (file: FileDiff, index: number) => {
    const forFile = drafts.filter((draft) => draft.file === file.path);
    const find = (target: LineTarget) =>
      forFile.find((draft) => draft.side === target.side && draft.line === target.line);
    const isComposing = (target: LineTarget) =>
      composing?.file === file.path &&
      composing.target.side === target.side &&
      composing.target.line === target.line;
    return (
      <FileDiffBlock
        key={file.path}
        id={`${anchor}-${index}`}
        file={file}
        view={viewOf(file.path)}
        onView={(next) => setViews((previous) => new Map(previous).set(file.path, next))}
        mode={prefs.mode}
        wrap={prefs.wrap}
        highlighted={(target) => !!find(target) || isComposing(target)}
        onComment={(target) => setComposing({ file: file.path, target })}
        renderAnnotation={(target) => {
          const draft = find(target);
          const label = `Comment on ${target.side === "old" ? "old " : ""}line ${target.line}`;
          if (isComposing(target))
            return (
              <CommentComposer
                label={label}
                {...textOf(draft)}
                onCancel={() => setComposing(undefined)}
                onSave={(text) => {
                  saveDraft(services.drafts, {
                    threadId,
                    file: file.path,
                    ...target,
                    text,
                    createdAt: Date.now(),
                  });
                  setComposing(undefined);
                }}
              />
            );
          if (!draft) return null;
          return (
            <DraftCard
              draft={draft}
              onSend={() => send([draft.key])}
              onEdit={() => setComposing({ file: file.path, target })}
              onDiscard={() =>
                discardDraft(
                  services.drafts,
                  draftKey(threadId, file.path, target.side, target.line),
                )
              }
            />
          );
        }}
      />
    );
  };
  return (
    <div className="pb-8">
      <div className="sticky top-0 z-[2] flex h-9 items-center gap-1.5 border-b bg-panel pr-2 pl-2.5">
        <Select
          label="Turn"
          value={current?.id ?? all}
          options={options}
          onValueChange={setPicked}
          className="h-[26px] min-w-0 gap-1 bg-transparent px-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        />
        <DiffStat {...stat} className="text-[12px]" />
        <span className="flex-1" />
        {unsent.length > 1 && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => send(unsent.map((draft) => draft.key))}
          >
            Send {unsent.length} comments
          </Button>
        )}
        <IconButton
          icon={ArrowElbowDownLeftIcon}
          label="Wrap long lines"
          size="sm"
          pressed={prefs.wrap}
          onClick={() => services.diffPrefs.set((value) => ({ ...value, wrap: !value.wrap }))}
        />
        <SegmentedControl
          label="Diff layout"
          size="sm"
          value={prefs.mode}
          options={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
          ]}
          onValueChange={(mode) => services.diffPrefs.set((value) => ({ ...value, mode }))}
        />
      </div>
      <WorkingTree details={thread?.details} />
      {files.length > 1 && (
        <FileList
          files={files}
          anchor={anchor}
          jump={(index) => {
            const block = document.getElementById(`${anchor}-${index}`);
            if (block) block.scrollIntoView?.({ block: "start" });
            else blocks.current?.scrollToIndex(index);
          }}
        />
      )}
      {pending > 0 && (
        <p role="status" className="px-3.5 py-2 text-xs text-subtle-foreground">
          Preparing {pending === 1 ? "1 file" : `${pending} files`}…
        </p>
      )}
      {files.length > 1 && rows > virtualRowsAbove ? (
        <VirtualRows
          items={files}
          rowKey={(file) => file.path}
          estimate={(file) => fileHeight(file, viewOf(file.path))}
          render={(file, index) => renderFile(file, index)}
          handle={blocks}
        />
      ) : (
        files.map((file, index) => renderFile(file, index))
      )}
    </div>
  );
}

const identity = <T,>(value: T) => value;
const textOf = (draft: ReviewDraft | undefined) => (draft ? { initial: draft.text } : {});

function FileList(props: {
  files: readonly FileDiff[];
  anchor: string;
  jump(index: number): void;
}) {
  return (
    <nav aria-label="Changed files" className="border-b px-1.5 py-1.5">
      <div role="list">
        <LongRows
          items={props.files}
          virtualAbove={listAbove}
          rowKey={(file) => file.path}
          estimate={28}
          render={(file, index) => (
            <div role="listitem">
              <button
                type="button"
                onClick={() => props.jump(index)}
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
                <DiffStat additions={file.additions} deletions={file.deletions} />
              </button>
            </div>
          )}
        />
      </div>
    </nav>
  );
}
