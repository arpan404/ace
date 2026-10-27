import { useState } from "react";
import type { GitConflictFile, GitConflictHunk } from "@ace/protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import type { PrActions } from "./pr-actions.ts";
import { usePrConflicts, type PrConflicts } from "./pr-conflicts.ts";
import {
  conflictHunks,
  conflictRequest,
  editDraft,
  resolveHunk,
  type HunkChoice,
} from "@ace/ui-core";
import { useFixWithAgent } from "./pr-fix-with-agent.ts";

interface Branches {
  head: string;
  base: string;
}

/**
 * Resolve the PR's merge conflicts in ace: the base merged into the head in the linked task's
 * checkout, each conflicted file with its hunks (ours, base, theirs), and the merge pushed to
 * the head branch once nothing is left.
 */
export function PrConflictsDialog(props: {
  actions: PrActions;
  hostThreadId?: string | undefined;
  open: boolean;
  onClose(): void;
}) {
  const { detail } = props.actions.context;
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Resolve conflicts</DialogTitle>
          <DialogDescription>
            Merging <span className="font-mono">{detail.baseBranch}</span> into{" "}
            <span className="font-mono">{detail.headBranch}</span>
          </DialogDescription>
        </DialogHeader>
        {props.open && (
          <ConflictsBody
            actions={props.actions}
            hostThreadId={props.hostThreadId}
            onDone={props.onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConflictsBody(props: {
  actions: PrActions;
  hostThreadId: string | undefined;
  onDone(): void;
}) {
  const { context, threadId, worktree } = props.actions;
  const { detail, workspaceId } = context;
  const resolver = usePrConflicts({ workspaceId, detail, threadId, enabled: true });
  const agent = useFixWithAgent({ workspaceId, detail, hostThreadId: props.hostThreadId });
  const branches = { head: detail.headBranch, base: detail.baseBranch };
  const conflicts = resolver.conflicts;
  const busy = resolver.pending !== undefined;
  if (!threadId) return <Note>Link this pull request to a task first.</Note>;
  if (resolver.query.isError)
    return (
      <Note>
        {resolver.query.error.message}
        <Button size="sm" onClick={() => void resolver.query.refetch()}>
          Retry
        </Button>
      </Note>
    );
  if (conflicts === undefined)
    return (
      <LoadingRegion label="conflicts" className="flex flex-col gap-2 py-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-16 w-full rounded-md" />
        <Skeleton className="h-16 w-full rounded-md" />
      </LoadingRegion>
    );
  if (conflicts === null)
    return (
      <Note>
        The task&apos;s checkout doesn&apos;t hold this pull request.
        <Button
          size="sm"
          variant="primary"
          disabled={worktree.blocked !== undefined}
          title={worktree.blocked}
          onClick={() => void worktree.prepare(threadId)}
        >
          Check out pull request
        </Button>
      </Note>
    );
  const head = conflicts.head;
  if (!conflicts.merging) {
    const unpushed = head !== null && head !== detail.status.headSha;
    return (
      <Note>
        {conflicts.dirty
          ? "The checkout has uncommitted changes. Commit or discard them, then merge."
          : unpushed
            ? `The checkout has commits ${branches.head} on GitHub doesn't.`
            : null}
        <span className="flex gap-2">
          {unpushed && (
            <Button size="sm" disabled={busy} onClick={() => void resolver.push()}>
              {`Push to ${branches.head}`}
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={busy || conflicts.dirty || head === null}
            onClick={() => head && void resolver.start(head)}
          >
            {`Merge ${branches.base}`}
          </Button>
        </span>
      </Note>
    );
  }
  const finish = async () => {
    if (head && (await resolver.finish(head))) {
      props.onDone();
      void context.refresh();
    }
  };
  return (
    <div className="flex max-h-[min(70vh,720px)] min-h-0 flex-col gap-3">
      <div className="flex min-h-0 flex-col gap-3 overflow-auto">
        {conflicts.files.map((file) => (
          <ConflictFile
            key={`${file.path}:${file.content.kind === "text" ? file.content.revision : ""}`}
            file={file}
            branches={branches}
            resolver={resolver}
            onAsk={() => {
              // The request waits in the task's composer; closing shows it there.
              props.onDone();
              agent.ask(
                conflictRequest({
                  path: file.path,
                  number: detail.status.ref.number,
                  baseBranch: branches.base,
                  headBranch: branches.head,
                }),
              );
            }}
          />
        ))}
        {conflicts.files.length === 0 && (
          <p className="text-ui text-muted-foreground">Every conflict is resolved.</p>
        )}
        {conflicts.truncated && (
          <p className="text-xs text-muted-foreground">More files conflict than shown here.</p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void resolver.abort()}>
          Abort merge
        </Button>
        <Button
          variant="primary"
          disabled={busy || conflicts.files.length > 0 || head === null}
          onClick={() => void finish()}
        >
          {`Commit and push to ${branches.head}`}
        </Button>
      </div>
    </div>
  );
}

function Note(props: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 py-2 text-ui text-muted-foreground">
      {props.children}
    </div>
  );
}

const unavailable: Record<string, string> = {
  binary: "Binary file: take one side.",
  too_large: "Too large to show here: take one side or ask the agent.",
  missing: "Not in the checkout: take one side.",
  unsupported: "Not a regular file: take one side.",
};

function stageNote(file: GitConflictFile, branches: Branches): string | undefined {
  if (!file.stages.ours) return `Deleted on ${branches.head}`;
  if (!file.stages.theirs) return `Deleted on ${branches.base}`;
  if (!file.stages.base) return "Added on both";
  return undefined;
}

function ConflictFile(props: {
  file: GitConflictFile;
  branches: Branches;
  resolver: PrConflicts;
  onAsk(): void;
}) {
  const { file, resolver } = props;
  const busy = resolver.pending !== undefined;
  const note = stageNote(file, props.branches);
  const content = file.content;
  const segments = content.kind === "text" ? content.segments : [];
  const hunks = conflictHunks(segments);
  return (
    <section aria-label={file.path} className="rounded-card border border-border">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{file.path}</span>
        {note && <span className="text-meta text-muted-foreground">{note}</span>}
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => void resolver.take(file.path, "ours")}
        >
          Take ours
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => void resolver.take(file.path, "theirs")}
        >
          Take theirs
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onAsk}>
          Ask agent
        </Button>
      </header>
      {content.kind === "unavailable" ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{unavailable[content.reason]}</p>
      ) : hunks.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No conflict markers left. Take a side to mark it resolved.
        </p>
      ) : (
        hunks.map(({ hunk, start }, index) => (
          <Hunk
            key={start}
            hunk={hunk}
            label={`Conflict ${index + 1} of ${hunks.length}`}
            branches={props.branches}
            disabled={busy}
            onChoose={(choice) =>
              resolver.write(file.path, resolveHunk(segments, index, choice), content.revision)
            }
          />
        ))
      )}
    </section>
  );
}

function Side(props: { label: string; text: string }) {
  return (
    <div className="min-w-0">
      <p className="px-3 pt-2 text-meta text-muted-foreground">{props.label}</p>
      <pre className="overflow-x-auto px-3 py-1 font-mono text-xs whitespace-pre">
        {props.text || " "}
      </pre>
    </div>
  );
}

/** One hunk, three-way: ours, the merge base, theirs; then Use ours, Use theirs or Edit. */
function Hunk(props: {
  hunk: GitConflictHunk;
  label: string;
  branches: Branches;
  disabled: boolean;
  onChoose(choice: HunkChoice): Promise<unknown>;
}) {
  const { hunk } = props;
  const [draft, setDraft] = useState<string>();
  return (
    <div role="group" aria-label={props.label} className="border-b border-border last:border-b-0">
      <Side label={`Ours · ${props.branches.head}`} text={hunk.ours} />
      {hunk.base !== null && <Side label="Base" text={hunk.base} />}
      <Side label={`Theirs · ${props.branches.base}`} text={hunk.theirs} />
      {draft !== undefined ? (
        <form
          className="flex flex-col gap-2 px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void props.onChoose({ kind: "edit", text: draft });
          }}
        >
          <Textarea
            aria-label={`${props.label}: resolved text`}
            className="min-h-24 font-mono text-xs"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                event.currentTarget.form?.requestSubmit();
            }}
          />
          <span className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={props.disabled}>
              Save resolution
            </Button>
          </span>
        </form>
      ) : (
        <div className="flex gap-2 px-3 py-2">
          <Button
            size="sm"
            disabled={props.disabled}
            onClick={() => void props.onChoose({ kind: "ours" })}
          >
            Use ours
          </Button>
          <Button
            size="sm"
            disabled={props.disabled}
            onClick={() => void props.onChoose({ kind: "theirs" })}
          >
            Use theirs
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(editDraft(hunk))}>
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}
