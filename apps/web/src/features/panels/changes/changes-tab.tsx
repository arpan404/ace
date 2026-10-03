import { useClient, useThreadMeta } from "@ace/client-react";
import { ArrowElbowDownLeftIcon, GitDiffIcon } from "@phosphor-icons/react";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { countChanges, fileDiffs } from "@ace/ui-core";
import { DiffStat } from "./diff-stat.tsx";
import { discardDraft, draftKey, saveDraft, sendDrafts, type ReviewDraft } from "./drafts.ts";
import { FileDiffBlock, type LineTarget } from "./file-diff.tsx";
import { CommentComposer, DraftCard } from "./line-comment.tsx";
import { useTurns } from "./use-turns.ts";

const all = "all";

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
  const anchor = useId();

  // Default to the latest turn that edited something; "All turns" shows the whole thread.
  const current =
    picked === all ? undefined : (edited.find((turn) => turn.id === picked) ?? edited.at(-1));
  const files = useMemo(
    () => fileDiffs(current ? current.edits : edited.flatMap((turn) => turn.edits)),
    [current, edited],
  );
  const stat = countChanges(files.flatMap((file) => file.rows));
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
      {files.length > 1 && <FileList files={files} anchor={anchor} />}
      {files.map((file, index) => {
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
      })}
    </div>
  );
}

const identity = <T,>(value: T) => value;
const textOf = (draft: ReviewDraft | undefined) => (draft ? { initial: draft.text } : {});

function FileList(props: { files: ReturnType<typeof fileDiffs>; anchor: string }) {
  return (
    <nav aria-label="Changed files" className="border-b px-1.5 py-1.5">
      <ul>
        {props.files.map((file, index) => (
          <li key={file.path}>
            <button
              type="button"
              onClick={() =>
                document
                  .getElementById(`${props.anchor}-${index}`)
                  ?.scrollIntoView?.({ block: "start" })
              }
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              <DiffStat additions={file.additions} deletions={file.deletions} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
