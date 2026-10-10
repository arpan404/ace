import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { useThreadMeta } from "@ace/client-react";
import { baseRecordText } from "@ace/ui-core";
import { CopyIcon, GitForkIcon, LaptopIcon, WarningIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCheckout } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";

/**
 * Where a thread runs, opened from the strip below the composer: its own worktree or the local checkout, the
 * branch and how far it is from its upstream, what a worktree started from (and whether the
 * remote could be reached then), the path and the machine. The daemon fixes the place
 * when the thread starts, so this reports it; the path can be copied.
 */
export function ThreadEnvironmentCard(props: { thread: ThreadRef }) {
  const checkout = useCheckout(props.thread);
  const details = useThreadMeta(props.thread.id)?.details;
  const toast = useToast();
  const host = useMachineIdentity(details?.machine);
  const worktree = checkout?.mode === "worktree";
  const path = details?.worktree ?? details?.workspace?.path;
  const base = details?.base ? baseRecordText(details.base) : undefined;
  const sync = checkout
    ? [
        checkout.ahead > 0 && `${checkout.ahead} ahead`,
        checkout.behind > 0 && `${checkout.behind} behind`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const copy = (text: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => toast.add({ title: "Path copied" }),
      () => toast.add({ title: "Couldn't copy the path" }),
    );
  return (
    <section aria-label="Where this thread runs">
      <div className="px-2.5 py-2">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
            {worktree ? (
              <GitForkIcon aria-hidden size={16} />
            ) : (
              <LaptopIcon aria-hidden size={16} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-ui font-medium text-foreground">
              {checkout
                ? worktree
                  ? "Its own worktree"
                  : "Local checkout"
                : "Reading the checkout…"}
            </h3>
            <p className="text-xs text-subtle-foreground">
              {worktree
                ? "A branch and folder of its own; your checkout stays as it is."
                : "Works directly in the project's folder, on its current branch."}
            </p>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-sm">
          {checkout && (
            <Row term="Branch">
              <span className="font-mono">{checkout.branch ?? "detached HEAD"}</span>
              {sync && <span className="text-subtle-foreground"> · {sync}</span>}
            </Row>
          )}
          {checkout?.head && (
            <Row term="Commit">
              <span className="font-mono">{checkout.head.slice(0, 7)}</span>
            </Row>
          )}
          {worktree && (base || checkout?.baseBranch) && (
            <Row term="Started from">
              <span className="block font-mono">{base?.text ?? checkout?.baseBranch}</span>
              {base?.note && (
                <span className="mt-0.5 flex items-start gap-1.5 text-xs text-status-needs-you">
                  <WarningIcon aria-hidden size={13} className="mt-px shrink-0" />
                  {base.note}
                </span>
              )}
            </Row>
          )}
          {path && (
            <Row term="Path">
              <span className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate font-mono" title={path}>
                  {path}
                </span>
                <IconButton
                  icon={CopyIcon}
                  label="Copy path"
                  size="sm"
                  onClick={() => copy(path)}
                />
              </span>
            </Row>
          )}
          {host && (
            <Row term="Machine">
              <MachineLabel name={host.name} icon={host.icon} />
            </Row>
          )}
        </dl>
      </div>
    </section>
  );
}

function Row(props: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-subtle-foreground">{props.term}</dt>
      <dd className="min-w-0 text-foreground">{props.children}</dd>
    </>
  );
}
