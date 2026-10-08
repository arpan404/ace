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
  const text = commit
    ? { title: "Commit changes", submit: push ? "Commit & push" : "Commit" }
    : {
        title: draft ? "Open a draft pull request" : "Open a pull request",
        submit: draft ? "Create draft PR" : "Create PR",
      };
  const reviewers = parseReviewers(reviewerText);
  const submit = () => {
    const title = subject.trim();
    if (!title || props.pending || nothing || (commit && !files)) return;
    if ("error" in reviewers) return setError(reviewers.error);
    setError(undefined);
    const message = body.trim() ? `${title}\n\n${body.trim()}` : title;
    const change: GitChange = commit
      ? { kind: "commit", message, push, paths: pathsOf(files ?? [], chosen) }
      : { kind: "create-pr", title, summary: body.trim(), draft, ...reviewers };
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
              {commit ? (
                <>
                  The files you pick, on{" "}
                  <span className="font-mono whitespace-nowrap">{checkout.branch ?? "HEAD"}</span>
                  {push && ", then pushed to origin"}.
                </>
              ) : (
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
              onChange={(event) => setSubject(event.target.value)}
            />
            <Textarea
              aria-label={commit ? "Commit details" : "Pull request description"}
              placeholder={commit ? "Details (optional)" : "What changed and why (optional)"}
              value={body}
              maxLength={8000}
              onChange={(event) => setBody(event.target.value)}
            />
            {!commit && (
              <Input
                aria-label="Reviewers"
                placeholder="Reviewers: GitHub usernames (optional)"
                value={reviewerText}
                maxLength={2000}
                onChange={(event) => setReviewerText(event.target.value)}
              />
            )}
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
                <span>· not ready for review yet</span>
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
              disabled={!subject.trim() || props.pending || nothing || (commit && !files)}
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
