import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import type { Checkout } from "@ace/ui-core";
import type { GitChange } from "../lib/use-git.ts";

export type GitDialogKind = "commit" | "commit-push" | "pr" | "draft-pr";

/** Every uncommitted file in the checkout, which can be more than one turn changed. */
const uncommitted = (count: number) =>
  `${count} uncommitted ${count === 1 ? "file" : "files"} in the checkout`;

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
  // The split button's menu presets these; the dialog lets the person change them either way.
  const [push, setPush] = useState(kind === "commit-push");
  const [draft, setDraft] = useState(kind === "draft-pr");
  const pushId = useId();
  const draftId = useId();
  const text = commit
    ? { title: "Commit changes", submit: push ? "Commit & push" : "Commit" }
    : {
        title: draft ? "Open a draft pull request" : "Open a pull request",
        submit: draft ? "Create draft PR" : "Create PR",
      };
  const submit = () => {
    const title = subject.trim();
    if (!title || props.pending) return;
    setError(undefined);
    const message = body.trim() ? `${title}\n\n${body.trim()}` : title;
    const change: GitChange = commit
      ? { kind: "commit", message, push }
      : { kind: "create-pr", title, summary: body.trim(), draft };
    props
      .onSubmit(change)
      .then(props.onClose, (failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Git couldn't finish that."),
      );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{text.title}</DialogTitle>
            <DialogDescription>
              {commit ? (
                <>
                  {uncommitted(checkout.changed)} on{" "}
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
              <Switch
                id={draftId}
                checked={draft}
                onCheckedChange={(checked) => setDraft(checked)}
              />
              Draft
              <span className="text-subtle-foreground">· reviewers aren't asked yet</span>
            </label>
          )}
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
              <Kbd
                aria-hidden
                keys="mod+enter"
                variant="bare"
                className="text-tint-foreground/60"
              />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
