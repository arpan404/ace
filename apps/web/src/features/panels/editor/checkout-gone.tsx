import { useThreadMeta } from "@ace/client-react";

/**
 * The thread's checkout folder no longer exists: its path, or undefined while it is there. The
 * daemon reports it (`worktreeMissing`); no read of the folder can succeed until it is back.
 */
export function useCheckoutGone(threadId: string): string | undefined {
  const details = useThreadMeta(threadId)?.details;
  if (details?.worktreeMissing !== true) return undefined;
  return details.worktree ?? details.workspace?.path ?? "";
}

/**
 * Said in words in place of the explorer and editor, with no Try again: nothing here can bring
 * the folder back (the Work card's checkout row says what can).
 */
export function CheckoutGone(props: { path: string }) {
  return (
    <div
      role="status"
      className="flex flex-1 flex-col gap-1 px-4 pt-6 text-ui text-muted-foreground"
    >
      <p className="text-foreground">This checkout's folder is gone:</p>
      {props.path && (
        <p className="font-mono text-xs break-all text-subtle-foreground">{props.path}</p>
      )}
    </div>
  );
}
