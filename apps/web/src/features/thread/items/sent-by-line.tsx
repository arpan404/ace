import { useSidebarThread } from "@ace/client-react";
import { sentByLine, type SentBy } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { threadOn, useMachineSearch } from "@/lib/machine-routes.ts";
import { useMachines } from "@/lib/machines.ts";

const line = "mb-1 flex max-w-[80%] min-w-0 items-center gap-1.5 text-xs text-muted-foreground";
/** Quiet at rest; the whole line brightens to full ink under the pointer or keyboard focus. */
const linked = `${line} focus-ring cursor-pointer rounded-sm transition-colors duration-[120ms] hover:text-foreground focus-visible:text-foreground`;

/**
 * The quiet line above a message another thread's agent sent: the sender's provider mark, then
 * "Sent by <thread title>", with " · <machine>" when the sender is on another machine. The title
 * is the thread's current one where this machine lists it; a long one ends in an ellipsis, with
 * the whole line in the tooltip. It opens the sending thread: on this machine, or on the paired
 * machine while that machine is reachable. Out of reach, or unknown, it is plain text.
 */
export function SentByLine(props: { sent: SentBy }) {
  const { sent } = props;
  const local = sent.host ? undefined : sent.threadId;
  const sender = useSidebarThread(local ?? "");
  const search = useMachineSearch();
  const machines = useMachines();
  const provider = sent.provider ?? sender?.provider;
  const text = sentByLine({ ...sent, provider }, sender?.title);
  const content = (
    <>
      {provider && <ProviderIcon provider={provider} size={12} decorative />}
      <span className="truncate">{text}</span>
    </>
  );
  const machine = sent.host && machines.find((each) => each.id === sent.host?.id);
  const target = local
    ? { ...threadOn(undefined, local), search }
    : sent.threadId && machine && machine.status === "online"
      ? threadOn(machine.primary ? undefined : machine.id, sent.threadId)
      : undefined;
  return (
    <Tip label={text}>
      {target ? (
        <Link {...target} className={linked}>
          {content}
        </Link>
      ) : (
        <p className={line}>{content}</p>
      )}
    </Tip>
  );
}
