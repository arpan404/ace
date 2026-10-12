import { DraftWriter } from "./draft-writer.tsx";
import type { SourceControlSelection } from "@ace/protocol";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { ReviewerField } from "./reviewer-field.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { parseReviewers, type Checkout } from "@ace/ui-core";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";
import { useChangedFiles, type GitChange } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import { ChangedFiles, pathsOf, pickedByDefault } from "./changed-files.tsx";

export type GitDialogKind =
  | "commit"
  | "commit-push"
  | "pr"
  | "draft-pr"
  | "link-pr"
  | "request-review";

/**
 * What a commit or PR says, written by the person: the daemon commits and opens PRs exactly as
 * asked. The thread's title is the starting point for both.
 */
export function GitDialog(props: {
  kind: GitDialogKind;
  thread: ThreadRef;
  checkout: Checkout;
  pending: boolean;
  onSubmit(change: GitChange): Promise<unknown>;
  onClose(): void;
  /** Close the form and show the uncommitted changes (Changes). */
  onViewDiff(): void;
}) {
  const [subject, setSubject] = useState(props.thread.title);
  const [body, setBody] = useState("");
  const [textRevision, setTextRevision] = useState(0);
  const [draftSource, setDraftSource] = useState<{ fingerprint: string; selection: string }>();
  const [reviewerText, setReviewerText] = useState("");
  const [error, setError] = useState<string>();
  const { kind, checkout } = props;
  const commit = kind === "commit" || kind === "commit-push";
  // The split button's menu presets these; the dialog lets the person change them either way.
  const [push, setPush] = useState(kind === "commit-push");
  const [draft, setDraft] = useState(kind === "draft-pr");
  const pushId = useId();
  const draftId = useId();
  // What a commit takes: read fresh as the form opens, with every changed file picked.
  const status = useChangedFiles(props.thread, commit);
  const files = status.data?.files;
  const [picked, setPicked] = useState<ReadonlySet<string>>();
  const chosen = picked ?? (files ? pickedByDefault(files) : new Set<string>());
  const nothing = commit && chosen.size === 0;
  const selection: SourceControlSelection | undefined = commit
    ? files && chosen.size
      ? { kind: "commit", paths: pathsOf(files, chosen) }
      : undefined
    : checkout.branch
      ? {
          kind: "pr",
          branch: checkout.branch,
          base: checkout.baseBranch,
          ...(checkout.baseRef ? { baseRef: checkout.baseRef } : {}),
        }
      : undefined;
  const selectionKey = JSON.stringify(selection);
  const staleDraft = draftSource !== undefined && draftSource.selection !== selectionKey;
  const text = commit
    ? {
        title: `Commit to ${checkout.branch ?? "your checkout"}`,
        submit: push ? "Commit & push" : "Commit",
      }
    : {
        title: draft ? "Open a draft pull request" : "Open a pull request",
        submit: draft ? "Create draft PR" : "Create PR",
      };
  const reviewers = parseReviewers(reviewerText);
  const submit = () => {
    const title = subject.trim();
    if (!title || staleDraft || props.pending || nothing || (commit && !files)) return;
    if ("error" in reviewers) return setError(reviewers.error);
    setError(undefined);
    const message = body.trim() ? `${title}\n\n${body.trim()}` : title;
    const change: GitChange = commit
      ? {
          kind: "commit",
          message,
          push,
          paths: pathsOf(files ?? [], chosen),
          draftFingerprint: draftSource?.fingerprint,
        }
      : {
          kind: "create-pr",
          title,
          summary: body.trim(),
          draft,
          draftFingerprint: draftSource?.fingerprint,
          ...reviewers,
        };
    props
      .onSubmit(change)
      .then(props.onClose, (failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Git couldn't finish that."),
      );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size={commit ? "md" : "sm"}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{text.title}</DialogTitle>
            <DialogDescription>
              {!commit && (
                <>
                  <span className="font-mono whitespace-nowrap">{checkout.branch}</span> into{" "}
                  <span className="font-mono whitespace-nowrap">{checkout.baseBranch}</span>
                  {checkout.repository &&
                    ` on ${checkout.repository.owner}/${checkout.repository.name}`}
                  .
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {commit && (
              <ChangedFiles
                files={files}
                truncated={status.data?.truncated ?? false}
                failed={status.isError}
                picked={chosen}
                onPick={setPicked}
                onRetry={() => void status.refetch()}
                onViewDiff={props.onViewDiff}
              />
            )}
            <Input
              aria-label={commit ? "Commit message" : "Pull request title"}
              value={subject}
              maxLength={commit ? 200 : 256}
              autoFocus
              onChange={(event) => {
                setSubject(event.target.value);
                setTextRevision((value) => value + 1);
              }}
            />
            <Textarea
              aria-label={commit ? "Commit details" : "Pull request description"}
              placeholder={commit ? "Details (optional)" : "What changed and why (optional)"}
              value={body}
              maxLength={8000}
              onChange={(event) => {
                setBody(event.target.value);
                setTextRevision((value) => value + 1);
              }}
            />
            <DraftWriter
              thread={props.thread}
              selection={selection}
              textRevision={textRevision}
              disabled={props.pending}
              onApply={(generated, context) => {
                setSubject(generated.subject);
                setBody(generated.body);
                setTextRevision((value) => value + 1);
                setDraftSource({ fingerprint: context.fingerprint, selection: selectionKey });
              }}
            />
            {draftSource && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>
                  {staleDraft
                    ? "The draft's selected files changed. Generate again or discard the draft."
                    : "Draft applied. Review and edit before submitting."}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraftSource(undefined);
                  }}
                >
                  Discard draft tracking
                </Button>
              </div>
            )}
            {!commit && <ReviewerField onChange={setReviewerText} />}
            {/* In a form, a one-off option is a checkbox; switches are for settings. */}
            {commit ? (
              <label
                htmlFor={pushId}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Checkbox
                  id={pushId}
                  checked={push}
                  disabled={!checkout.branch}
                  onCheckedChange={(checked) => setPush(checked)}
                />
                Push after committing
              </label>
            ) : (
              <label
                htmlFor={draftId}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Checkbox
                  id={draftId}
                  checked={draft}
                  onCheckedChange={(checked) => setDraft(checked)}
                />
                Draft
              </label>
            )}
          </DialogBody>
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              <InlineMarkdown text={error} />
            </p>
          )}
          <DialogFooter submitHint>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                !subject.trim() || staleDraft || props.pending || nothing || (commit && !files)
              }
            >
              {props.pending && <Spinner />}
              {text.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
