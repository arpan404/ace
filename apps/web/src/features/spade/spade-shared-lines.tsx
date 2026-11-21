import { useAceAccount } from "@/features/ace-account/index.ts";
import { approverLine, useOrgMembers } from "@/features/ace-org/index.ts";
import { cn } from "@/lib/cn.ts";
import { CardBody } from "./spade-card.tsx";
import { useSpadeMachine } from "./spade-machine.tsx";
import { useBotSharing } from "./spade-org-api.ts";

/*
 * A shared bot's marks (ADR 0206 §2.3): "Shared" beside its name in the list, "Shared in Acme"
 * under it on its page, and on each of its requests who may answer it. A bot on a personal
 * machine shows none of them.
 */

/** "Shared" beside a shared bot's name in the list, in the row's quieter word. */
export function SharedWord(props: { bot: { id: string; machine: { key: string } } }) {
  const sharing = useBotSharing(props.bot);
  if (!sharing) return null;
  return (
    <span
      title={`Shared in ${sharing.orgName}`}
      className="shrink-0 text-ui/5 font-normal text-subtle-foreground"
    >
      Shared
    </span>
  );
}

/** "Shared in Acme", for the line under a bot's name on its page; undefined for a bot of one's own. */
export function useSharedIn(bot: { id: string; machine: { key: string } }): string | undefined {
  const sharing = useBotSharing(bot);
  return sharing ? `Shared in ${sharing.orgName}` : undefined;
}

/**
 * Under a shared bot's request: whether the person is one of its approvers and who else may
 * answer, named from the organization's members. Nothing for a bot of the person's own.
 */
export function ApproversLine(props: { botId: string; className?: string }) {
  const machine = useSpadeMachine().key;
  const sharing = useBotSharing({ id: props.botId, machine: { key: machine } });
  const members = useOrgMembers(sharing?.access.org).data;
  const self = useAceAccount().session?.account.id;
  if (!sharing) return null;
  const said = approverLine({
    approvers: sharing.access.approvers,
    nameOf: (account) => {
      const member = members?.find((each) => each.account === account);
      return member?.name || member?.email;
    },
    self,
  });
  return (
    <CardBody>
      <p
        data-approvers={said.canAnswer ? "you" : "others"}
        className={cn("text-ui leading-5 text-muted-foreground", props.className)}
      >
        {said.line}
      </p>
    </CardBody>
  );
}
