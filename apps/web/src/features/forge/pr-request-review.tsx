import { useRef, useState } from "react";
import { parseReviewRequest } from "@ace/ui-core";
import {
  useMarkdownCompletions,
  type CompletionPerson,
} from "@/components/markdown-editor/completion-source.ts";
import { useSearch } from "@/components/markdown-editor/use-search.ts";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";
import type { PrActions } from "./pr-actions.ts";
import { PrAvatar } from "./pr-presentation.tsx";
import { usePrReview } from "./pr-review-context.tsx";
import { suggestedReviewers } from "./pr-reviewers-model.ts";
import { usePrReviewers } from "./pr-reviewers-query.ts";

type Candidate = CompletionPerson & { reason?: string | undefined };

/** The names finished so far, and the word still being typed at the end (if any). */
function tokens(text: string) {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const typing = /[\s,]$/.test(text) || !parts.length ? "" : (parts.pop() ?? "");
  return { done: parts, typing: typing.replace(/^@/, "") };
}

const named = (part: string, login: string) =>
  part.replace(/^@/, "").toLowerCase() === login.toLowerCase();

/** The text with `login` in place of the word being typed, or toggled when nothing is. */
function toggled(text: string, login: string): string {
  const { done, typing } = tokens(text);
  const has = done.some((part) => named(part, login));
  const next = has
    ? typing
      ? done
      : done.filter((part) => !named(part, login))
    : [...done, login];
  return next.length ? `${next.join(", ")}, ` : "";
}

/** Who to offer: GitHub's suggestions before anything is typed, else the people matching it. */
function useCandidates(
  typing: string,
  suggested: readonly Candidate[],
): { title: string; people: readonly Candidate[] } {
  const source = useMarkdownCompletions();
  const people = source?.people;
  const found = useSearch(typing && people ? typing : undefined, (signal) =>
    people ? people(typing, signal) : Promise.resolve([]),
  );
  if (!typing) return { title: "Suggested", people: suggested };
  return { title: "People", people: found?.key === typing ? (found.value ?? []) : [] };
}

/**
 * Ask people or teams to review: GitHub's suggested reviewers first, any login or `org/team`
 * typed, with the repository's people found as you type. Picking a row adds it to the list;
 * picking it again takes it out.
 */
export function RequestReviewDialog(props: { actions: PrActions; open: boolean; onClose(): void }) {
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const { writes, context } = props.actions;
  const parsed = parseReviewRequest(text, context.detail.status.ref.repository.owner);
  const review = usePrReview();
  const reviewers = usePrReviewers(context.workspaceId, context.detail);
  const author = context.detail.author.toLowerCase();
  const asked = new Set(
    (reviewers.data?.requested ?? []).flatMap((r) =>
      r.kind === "user" ? [r.login.toLowerCase()] : [],
    ),
  );
  const suggested: Candidate[] = reviewers.data
    ? suggestedReviewers(reviewers.data).map((person) => ({
        login: person.login,
        name: person.name,
        avatarUrl: person.avatarUrl,
        reason: person.isCommenter ? "Commented here" : "Recently edited these files",
      }))
    : [];
  const { done, typing } = tokens(text);
  const candidates = useCandidates(typing, suggested);
  const shown = candidates.people
    .filter((p) => p.login.toLowerCase() !== author && !asked.has(p.login.toLowerCase()))
    .slice(0, 6);
  const request = "reviewers" in parsed ? parsed : { reviewers: [], teams: [] };
  const count = request.reviewers.length + request.teams.length;
  const close = () => {
    props.onClose();
  };
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!count || !review) return;
            props.onClose();
            // Asked of the PR itself: no linked task is needed.
            void review
              .run({
                kind: "reviewers.request",
                reviewers: request.reviewers,
                ...(request.teams.length ? { teams: request.teams } : {}),
              })
              .then((ok) => {
                void reviewers.refetch();
                if (ok) setText("");
              });
          }}
        >
          <DialogHeader>
            <DialogTitle>Request review</DialogTitle>
          </DialogHeader>
          <Input
            ref={field}
            aria-label="Reviewers"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Usernames, or org/team"
            autoComplete="off"
          />
          {"error" in parsed && text.trim() && (
            <p role="status" className="text-xs text-muted-foreground">
              {parsed.error}
            </p>
          )}
          {shown.length > 0 && (
            <section aria-label={candidates.title}>
              <h3 className="text-xs font-medium text-muted-foreground">{candidates.title}</h3>
              <ul className="mt-1 flex flex-col">
                {shown.map((person) => {
                  const added = done.some((part) => named(part, person.login));
                  return (
                    <li key={person.login} className="border-t border-border first:border-t-0">
                      <button
                        type="button"
                        aria-pressed={added}
                        aria-label={person.name ? `${person.login}, ${person.name}` : person.login}
                        className={cn(
                          "flex h-10 w-full items-center gap-2 rounded-sm px-1 text-left hover:bg-accent focus-ring",
                        )}
                        onClick={() => {
                          setText(toggled(text, person.login));
                          // Typing goes on in the field, ready for the next name.
                          field.current?.focus();
                        }}
                      >
                        <PrAvatar name={person.login} url={person.avatarUrl} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-ui text-foreground">
                            {person.login}
                            {person.name && (
                              <span className="ml-1.5 text-muted-foreground">{person.name}</span>
                            )}
                          </span>
                          {person.reason && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {person.reason}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {added ? "Added" : "Add"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                !count || !review?.ready || review.pending || writes.fenced || context.disabled
              }
            >
              Request review
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
