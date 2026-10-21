import { useThreadMeta } from "@ace/client-react";
import type { ForgePrRef, ForgePrStatus } from "@ace/protocol";
import { actionErrorText, mergeMethods, prBlocker, type Checkout } from "@ace/ui-core";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useCheckoutState, useGitActions, type GitChange, type GitResult } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import { gitFailureText } from "../lib/git-failure.ts";
import type { GitDialogKind } from "./git-dialog.tsx";
import { GitWriteConfirm } from "./git-write-confirm.tsx";
import { rememberMergeMethod } from "./merge-method.ts";

// Loaded on first open: the thread route's first paint doesn't need the commit or PR form.
const GitDialog = lazy(() => import("./git-dialog.tsx").then((m) => ({ default: m.GitDialog })));
const PrFieldDialog = lazy(() =>
  import("./pr-field-dialog.tsx").then((m) => ({ default: m.PrFieldDialog })),
);

/** What went wrong, in the daemon's words for its code, with commands set as code. */
export const failure = (error: unknown) => <InlineMarkdown text={gitFailureText(error)} />;

/**
 * What a change did that the Work card doesn't show by itself: the branch's existing PR linked
 * instead of a new one opened, or auto-merge waiting on checks. Anything else shows in place.
 */
function unseenOutcome(change: GitChange, result: GitResult): string | undefined {
  const number = result.status?.ref.number ?? "";
  if (change.kind === "create-pr" && result.existing) {
    const done = `Linked the branch's existing pull request #${number}`;
    return change.reviewers?.length
      ? `${done} · asked ${change.reviewers.join(", ")} to review`
      : done;
  }
  if (change.kind === "merge" && change.auto && result.status?.state !== "merged") {
    const how = mergeMethods.find((each) => each.method === change.method)?.label ?? "Merge";
    return `Auto-merge on: #${number} will ${how.toLowerCase()} once checks pass`;
  }
  return undefined;
}

const failed: Record<GitChange["kind"], string> = {
  commit: "Couldn't commit",
  push: "Couldn't push",
  "create-pr": "Couldn't open the pull request",
  "link-pr": "Couldn't link the pull request",
  "unlink-pr": "Couldn't unlink the pull request",
  "request-review": "Couldn't request a review",
  merge: "Couldn't merge",
};

/**
 * Commit, push, open or link a PR and act on it, with the forms that ask for them; a toast
 * only for a failure or an outcome the Work card doesn't show. The work card's branch row, its ⋯ menu and the PR popover all drive it, so they never
 * disagree about what is possible or why not.
 */
export function useGitFlow(thread: ThreadRef): {
  threadId: string;
  checkout: ReturnType<typeof useCheckoutState>["checkout"];
  status: ForgePrStatus | undefined;
  linkedPrs: ReturnType<typeof useCheckoutState>["linkedPrs"];
  /** Runs the change and confirms it; resolves with a partial result rather than throwing. */
  submit(change: GitChange): Promise<GitResult>;
  state: ReturnType<typeof useCheckoutState>["state"];
  /** The failed checkout read's words, with `retry` to read it again. */
  error: string | undefined;
  retry(): void;
  prProblem: ReturnType<typeof useCheckoutState>["prProblem"];
  pending: boolean;
  push(): void;
  /** Remote writes ask for confirmation; every command reports its reconciled result. */
  run(change: GitChange): void;
  /** Ask the forge for the PR's status now. */
  refreshPr(pr?: ForgePrRef): Promise<ForgePrStatus | undefined>;
  open(kind: GitDialogKind): void;
  /** Why a pull request can't be opened, when it can't. */
  prBlocked: string | undefined;
  /** Why a draft pull request can't be opened (one is already open), when it can't. */
  draftBlocked: string | undefined;
  /** Why an existing PR can't be linked, when it can't. */
  linkBlocked: string | undefined;
  /** The open form, if any: render it once. */
  dialog: ReactNode;
} {
  const { checkout, status, state, error, retry, prProblem, linkedPrs } = useCheckoutState(thread);
  const { change, pending, refreshPr } = useGitActions(thread, checkout);
  const [dialog, setDialog] = useState<GitDialogKind>();
  const [confirm, setConfirm] = useState<Extract<GitChange, { kind: "merge" | "push" }>>();
  const toast = useToast();
  const workspace = useWorkspaceActions(thread.id);
  // A PR review worktree pushes to the pull request's own branch, not its local one.
  const pushBranch =
    useThreadMeta(thread.id)?.details?.pullRequestWorkspace?.headBranch ?? checkout?.branch;
  const submit = async (next: GitChange) => {
    const answered = await change(next);
    // Only a merge that went through makes its method the next one's default.
    if (next.kind === "merge") rememberMergeMethod(next.method);
    if (answered.partial?.step === "review-request")
      toast.error({
        title: `PR #${answered.status?.ref.number ?? ""} opened; review request failed`,
        description: failure(answered.partial.error),
      });
    // A commit whose push failed stays in its form, which offers the push alone.
    else if (!answered.partial) {
      const unseen = unseenOutcome(next, answered);
      if (unseen) toast.add({ title: unseen });
    }
    return answered;
  };
  const run = (next: GitChange) => {
    if (next.kind === "push") return setConfirm(next);
    if (next.kind === "merge") {
      const repository = checkout?.pr?.repo ?? checkout?.repository;
      return setConfirm({
        ...next,
        ...(next.pr
          ? {}
          : checkout?.pr && repository
            ? {
                pr: { repository, number: checkout.pr.number },
              }
            : {}),
      });
    }
    void submit(next).catch((reason: unknown) =>
      toast.error({ title: failed[next.kind], description: failure(reason) }),
    );
  };
  const unread = state === "error" ? "Couldn't read the checkout" : "Not a git checkout";
  const prBlocked = checkout ? prBlocker(checkout) : unread;
  const pr = checkout?.pr;
  const live = pr?.state === "open" || pr?.state === "draft";
  const draftBlocked = prBlocked ?? (live ? `PR #${pr.number} is already open` : undefined);
  const linkBlocked = !checkout
    ? unread
    : checkout.repository?.forge === "gitlab"
      ? prBlocker(checkout)
      : checkout.repository
        ? undefined
        : prBlocker(checkout);
  const close = () => setDialog(undefined);
  const form = (at: Checkout) =>
    dialog === "link-pr" || dialog === "request-review" ? (
      <PrFieldDialog kind={dialog} checkout={at} onSubmit={submit} onClose={close} />
    ) : (
      dialog && (
        <GitDialog
          kind={dialog}
          thread={thread}
          checkout={at}
          pending={pending}
          onSubmit={submit}
          onClose={close}
          onViewDiff={() => {
            close();
            workspace.open({ kind: "changes" });
          }}
        />
      )
    );
  return {
    threadId: thread.id,
    checkout,
    status,
    linkedPrs,
    submit,
    state,
    error: state === "error" ? actionErrorText(error) : undefined,
    retry,
    prProblem,
    pending,
    push: () => run({ kind: "push" }),
    run,
    refreshPr,
    open: setDialog,
    prBlocked,
    draftBlocked,
    linkBlocked,
    dialog:
      (dialog && checkout) || confirm ? (
        <>
          {dialog && checkout && <Suspense fallback={null}>{form(checkout)}</Suspense>}
          {confirm && (
            <GitWriteConfirm
              change={confirm}
              branch={pushBranch ?? "detached HEAD"}
              pending={pending}
              onSubmit={submit}
              renderError={failure}
              onClose={() => setConfirm(undefined)}
            />
          )}
        </>
      ) : null,
  };
}
