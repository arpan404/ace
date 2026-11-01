import { useSidebarThread } from "@ace/client-react";
import { sentByLine, type SentBy } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { threadOn, useMachineSearch } from "@/lib/machine-routes.ts";
import { useMachines } from "@/lib/machines.ts";
import { useIsChatThread } from "@/lib/projects.ts";

const line = "mb-1 flex max-w-[80%] items-center gap-1.5 text-xs text-subtle-foreground";

/**
 * The quiet line above a message another thread's agent sent: the sender's provider mark, then
 * "Sent by Claude Code from another thread". It opens the thread that sent it: on this machine,
 * or on the paired machine it names while that machine is reachable. When ace doesn't know the
 * sender, or its machine is out of reach, the line still says what it knows and links nowhere.
 */
export function SentByLine(props: { sent: SentBy }) {
  const { sent } = props;
  const local = sent.host ? undefined : sent.threadId;
  const sender = useSidebarThread(local ?? "");
  const isChat = useIsChatThread();
  const search = useMachineSearch();
  const machines = useMachines();
  const provider = sent.provider ?? sender?.provider;
  const text = sentByLine({ ...sent, provider }, { chat: !!sender && isChat(sender) });
  const content = (
    <>
      {provider && <ProviderIcon provider={provider} size={12} decorative />}
      <span className="truncate">{text}</span>
    </>
  );
  if (local)
    return (
      <Link {...threadOn(undefined, local)} search={search} className={linked}>
        {content}
      </Link>
    );
  const machine = sent.host && machines.find((each) => each.id === sent.host?.id);
  if (sent.threadId && machine && machine.status === "online")
    return (
      <Link
        {...threadOn(machine.primary ? undefined : machine.id, sent.threadId)}
        className={linked}
      >
        {content}
      </Link>
    );
  return <p className={line}>{content}</p>;
}

const linked = `${line} focus-ring rounded-sm underline-offset-2 hover:text-foreground hover:underline`;
