import { useThreadMeta } from "@ace/client-react";
import { GitBranchIcon, GitForkIcon } from "@phosphor-icons/react";
import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { useMachineIdentity } from "@/lib/machine-identity.ts";
import { useCheckout } from "../lib/use-git.ts";
import type { ThreadRef } from "../sources/index.ts";
import { stripRow } from "./composer-styles.ts";

/** Branch and machine stay visible below the composer, including while requests are open. */
export function EnvironmentStrip(props: { thread: ThreadRef }) {
  const checkout = useCheckout(props.thread);
  const details = useThreadMeta(props.thread.id)?.details;
  const host = useMachineIdentity(details?.machine);
  const Place = checkout?.mode === "worktree" ? GitForkIcon : GitBranchIcon;
  return (
    <section aria-label="Where this thread runs" className={stripRow}>
      <Place aria-hidden size={14} className="shrink-0" />
      <span className="min-w-0 truncate">
        {checkout?.branch ?? details?.branch ?? "Current branch"}
      </span>
      <span aria-hidden>·</span>
      <MachineLabel name={host.name} icon={host.icon} />
    </section>
  );
}
