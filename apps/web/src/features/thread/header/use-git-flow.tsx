import { prBlocker } from "@ace/ui-core";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useCheckoutState, useGitActions, type GitChange } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import type { GitDialogKind } from "./git-dialog.tsx";

// Loaded on first open: the thread route's first paint doesn't need the commit or PR form.
const GitDialog = lazy(() => import("./git-dialog.tsx").then((m) => ({ default: m.GitDialog })));

const failure = (error: unknown) =>
  error instanceof Error ? error.message : "The daemon couldn't do that.";

/**
 * Commit, push and open a PR for a thread's checkout, with the commit and PR forms and the toasts
 * that confirm them. The header's git button and the summary's ⋯ menu both drive it, so the two
 * never disagree about what is possible or why not.
 */
export function useGitFlow(thread: ThreadRef): {
  checkout: ReturnType<typeof useCheckoutState>["checkout"];
  state: ReturnType<typeof useCheckoutState>["state"];
  pending: boolean;
  push(): void;
  open(kind: GitDialogKind): void;
  /** Why a pull request can't be opened, when it can't. */
  prBlocked: string | undefined;
  /** Why a draft pull request can't be opened (one is already open), when it can't. */
  draftBlocked: string | undefined;
  /** The open form, if any: render it once. */
  dialog: ReactNode;
} {
  const { checkout, state } = useCheckoutState(thread);
  const { change, pending } = useGitActions(thread, checkout);
  const [dialog, setDialog] = useState<GitDialogKind>();
  const toast = useToast();
  const workspace = useWorkspaceActions(thread.id);
  const submit = async (next: GitChange) => {
    const number = await change(next);
    toast.add({
      title:
        next.kind === "commit"
          ? next.push
            ? "Committed and pushed"
            : "Committed"
          : next.kind === "push"
            ? "Pushed"
            : `${next.draft ? "Draft pull request" : "Pull request"} #${number ?? ""} opened`,
    });
  };
  const prBlocked = checkout ? prBlocker(checkout) : "Not a git checkout";
  const pr = checkout?.pr;
  const draftBlocked =
    prBlocked ??
    (pr?.state === "open" || pr?.state === "draft"
      ? `PR #${pr.number} is already open`
      : undefined);
  return {
    checkout,
    state,
    pending,
    push: () =>
      void submit({ kind: "push" }).catch((error: unknown) =>
        toast.error({ title: "Couldn't push", description: failure(error) }),
      ),
    open: setDialog,
    prBlocked,
    draftBlocked,
    dialog: dialog && checkout && (
      <Suspense fallback={null}>
        <GitDialog
          kind={dialog}
          thread={thread}
          checkout={checkout}
          pending={pending}
          onSubmit={submit}
          onClose={() => setDialog(undefined)}
          onViewDiff={() => {
            setDialog(undefined);
            workspace.open({ kind: "changes" });
          }}
        />
      </Suspense>
    ),
  };
}
