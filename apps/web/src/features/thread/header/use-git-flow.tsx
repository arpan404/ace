import type { ForgePrStatus } from "@ace/protocol";
import { actionErrorText, mergeMethods, prBlocker, type Checkout } from "@ace/ui-core";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useCheckoutState, useGitActions, type GitChange } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { GitDialogKind } from "./git-dialog.tsx";

// Loaded on first open: the thread route's first paint doesn't need the commit or PR form.
const GitDialog = lazy(() => import("./git-dialog.tsx").then((m) => ({ default: m.GitDialog })));
const PrFieldDialog = lazy(() =>
  import("./pr-field-dialog.tsx").then((m) => ({ default: m.PrFieldDialog })),
);

/** What went wrong, in the daemon's words for its code, with commands set as code. */
export const failure = (error: unknown) => (
  <InlineMarkdown text={error instanceof Error ? error.message : actionErrorText(undefined)} />
);

/** The toast that confirms a change, from what the daemon answered. */
function confirmation(change: GitChange, status: ForgePrStatus | undefined): string {
  const number = status?.ref.number ?? "";
  switch (change.kind) {
    case "commit":
      return change.push ? "Committed and pushed" : "Committed";
    case "push":
      return "Pushed";
    case "create-pr": {
      // The daemon links the branch's existing PR rather than opening a second one.
      const done =
        status && status.title !== change.title
          ? `Linked the branch's existing pull request #${number}`
          : `${change.draft ? "Draft pull request" : "Pull request"} #${number} opened`;
      return change.reviewers?.length
        ? `${done} · asked ${change.reviewers.join(", ")} to review`
        : done;
    }
    case "link-pr":
      return `Linked pull request #${number}`;
    case "request-review":
      return `Asked ${change.reviewers.join(", ")} to review`;
    case "merge": {
      const how = mergeMethods.find((each) => each.method === change.method)?.label ?? "Merge";
      if (!change.auto) return `Merged #${number}`;
      return status?.state === "merged"
        ? `Merged #${number}`
        : `Auto-merge on: #${number} will ${how.toLowerCase()} once checks pass`;
    }
  }
}

const failed: Record<GitChange["kind"], string> = {
  commit: "Couldn't commit",
  push: "Couldn't push",
  "create-pr": "Couldn't open the pull request",
  "link-pr": "Couldn't link the pull request",
  "request-review": "Couldn't request a review",
  merge: "Couldn't merge",
};

/**
 * Commit, push, open or link a PR and act on it, with the forms and the toasts that confirm
 * them. The work card's branch row, its ⋯ menu and the PR popover all drive it, so they never
 * disagree about what is possible or why not.
 */
export function useGitFlow(thread: ThreadRef): {
  checkout: ReturnType<typeof useCheckoutState>["checkout"];
  status: ForgePrStatus | undefined;
  state: ReturnType<typeof useCheckoutState>["state"];
  pending: boolean;
  push(): void;
  /** A change made straight away (Merge), confirmed or explained by a toast. */
  run(change: GitChange): void;
  /** Ask the forge for the PR's status now. */
  refreshPr(): Promise<void>;
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
  const { checkout, status, state } = useCheckoutState(thread);
  const { change, pending, refreshPr } = useGitActions(thread, checkout);
  const [dialog, setDialog] = useState<GitDialogKind>();
  const toast = useToast();
  const workspace = useWorkspaceActions(thread.id);
  const submit = async (next: GitChange) => {
    toast.add({ title: confirmation(next, await change(next)) });
  };
  const run = (next: GitChange) =>
    void submit(next).catch((error: unknown) =>
      toast.error({ title: failed[next.kind], description: failure(error) }),
    );
  const prBlocked = checkout ? prBlocker(checkout) : "Not a git checkout";
  const pr = checkout?.pr;
  const live = pr?.state === "open" || pr?.state === "draft";
  const draftBlocked = prBlocked ?? (live ? `PR #${pr.number} is already open` : undefined);
  const linkBlocked = !checkout
    ? "Not a git checkout"
    : checkout.repository?.forge === "gitlab"
      ? prBlocker(checkout)
      : checkout.repository
        ? live
          ? `PR #${pr.number} is already linked`
          : undefined
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
    checkout,
    status,
    state,
    pending,
    push: () => run({ kind: "push" }),
    run,
    refreshPr,
    open: setDialog,
    prBlocked,
    draftBlocked,
    linkBlocked,
    dialog: dialog && checkout && <Suspense fallback={null}>{form(checkout)}</Suspense>,
  };
}
