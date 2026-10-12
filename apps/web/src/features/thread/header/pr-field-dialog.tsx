import { gitFailureText } from "../lib/git-failure.ts";
import { usePrReference } from "../lib/use-pr-reference.ts";
import { parseReviewers, type Checkout } from "@ace/ui-core";
import { useState } from "react";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { GitChange } from "../lib/use-git.ts";

const forms = {
  "link-pr": {
    title: "Link an existing pull request",
    label: "Pull request",
    placeholder: "42, #42 or its GitHub address",
    submit: "Link",
  },
  "request-review": {
    title: "Request a review",
    label: "Reviewers",
    placeholder: "GitHub usernames, separated by commas",
    submit: "Request",
  },
} as const;

/**
 * One field about the linked PR: which existing PR the thread should follow, or who should
 * review it. The field is read as the forge would (a number or address; usernames), and a
 * refusal stays in the form with its fix.
 */
export function PrFieldDialog(props: {
  kind: keyof typeof forms;
  checkout: Checkout;
  onSubmit(change: GitChange): Promise<unknown>;
  onClose(): void;
}) {
  const form = forms[props.kind];
  const parseReference = usePrReference();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const { repository, pr } = props.checkout;
  const parse = async (): Promise<GitChange | string> => {
    if (props.kind === "request-review") {
      const parsed = parseReviewers(value);
      if ("error" in parsed) return parsed.error;
      return parsed.reviewers.length
        ? { kind: "request-review", reviewers: parsed.reviewers }
        : "Name at least one GitHub username";
    }
    if (!repository) return "This checkout has no GitHub remote";
    const parsed = await parseReference(value, repository);
    return "error" in parsed
      ? parsed.error
      : {
          kind: "link-pr",
          number: parsed.number,
          ...(parsed.repository ? { repository: parsed.repository } : {}),
        };
  };
  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const change = await parse();
      if (typeof change === "string") return setError(change);
      await props.onSubmit(change);
      props.onClose();
    } catch (failure) {
      setError(gitFailureText(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{form.title}</DialogTitle>
            <DialogDescription>
              {props.kind === "link-pr"
                ? repository && `A pull request on ${repository.owner}/${repository.name}.`
                : pr && `On #${pr.number}${pr.title ? ` · ${pr.title}` : ""}.`}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={form.label}
            placeholder={form.placeholder}
            value={value}
            maxLength={2000}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-status-failed">
              <InlineMarkdown text={error} />
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!value.trim() || pending}>
              {pending && <Spinner />}
              {form.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
