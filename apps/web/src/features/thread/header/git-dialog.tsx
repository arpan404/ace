import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { Checkout } from "@ace/ui-core";
import type { GitChange } from "../lib/use-git.ts";

export type GitDialogKind = "commit" | "commit-push" | "pr" | "draft-pr";

const copy: Record<GitDialogKind, { title: string; submit: string }> = {
  commit: { title: "Commit changes", submit: "Commit" },
  "commit-push": { title: "Commit and push", submit: "Commit & push" },
  pr: { title: "Open a pull request", submit: "Create PR" },
  "draft-pr": { title: "Open a draft pull request", submit: "Create draft PR" },
};

/**
 * What a commit or PR says, written by the person: the daemon commits and opens PRs exactly as
 * asked. The thread's title is the starting point for both.
 */
export function GitDialog(props: {
  kind: GitDialogKind;
  title: string;
  checkout: Checkout;
  pending: boolean;
  onSubmit(change: GitChange): Promise<unknown>;
  onClose(): void;
}) {
  const [subject, setSubject] = useState(props.title);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const { kind, checkout } = props;
  const commit = kind === "commit" || kind === "commit-push";
  const text = copy[kind];
  const submit = () => {
    const title = subject.trim();
    if (!title || props.pending) return;
    setError(undefined);
    const message = body.trim() ? `${title}\n\n${body.trim()}` : title;
    const change: GitChange = commit
      ? { kind: "commit", message, push: kind === "commit-push" }
      : { kind: "create-pr", title, summary: body.trim(), draft: kind === "draft-pr" };
    props
      .onSubmit(change)
      .then(props.onClose, (failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Git couldn't finish that."),
      );
  };
  const files = `${checkout.changed} ${checkout.changed === 1 ? "file" : "files"}`;
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
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
                  {files} on <span className="font-mono">{checkout.branch ?? "HEAD"}</span>
                  {kind === "commit-push" && ", then pushed to origin"}.
                </>
              ) : (
                <>
                  <span className="font-mono">{checkout.branch}</span> into{" "}
                  <span className="font-mono">{checkout.baseBranch}</span>
                  {checkout.repository &&
                    ` on ${checkout.repository.owner}/${checkout.repository.name}`}
                  .
                </>
              )}
            </DialogDescription>
          </DialogHeader>
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
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!subject.trim() || props.pending}>
              {props.pending && <Spinner />}
              {text.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
