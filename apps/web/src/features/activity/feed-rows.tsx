import { useInteraction, useInteractions, useSidebarThread } from "@ace/client-react";
import type { InteractionRequest } from "@ace/protocol";
import {
  ChatCircleIcon,
  ListChecksIcon,
  PlugIcon,
  WarningIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { useNow } from "@/lib/time.ts";
import { useSidebarInline } from "@/lib/breakpoints.ts";
import { approvalCopy, formatAge, privateBrowserGate } from "@ace/ui-core";
import { interactionKey, useActivityState } from "./activity-state.tsx";
import { FeedRow } from "./feed-row.tsx";
import { requestTitle } from "./question-card.tsx";
import { useProjectName } from "@/lib/projects.ts";

const glyph = (icon: PhosphorIcon) => <Icon icon={icon} size={16} />;

const requestIcons: Record<InteractionRequest["kind"], PhosphorIcon> = {
  approval: WarningIcon,
  question: ChatCircleIcon,
  plan_review: ListChecksIcon,
  elicitation: PlugIcon,
};

/** A thread's open requests, each a row that focuses its card in the main column. */
export function ThreadNeedsRows(props: { threadId: string }) {
  const open = useInteractions(props.threadId);
  return (open ?? []).map((id) => (
    <InteractionRow key={id} threadId={props.threadId} interactionId={id} />
  ));
}

function InteractionRow(props: { threadId: string; interactionId: string }) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const thread = useSidebarThread(props.threadId);
  const { focused, setFocused, selectItem } = useActivityState();
  const wide = useSidebarInline();
  const now = useNow();
  const projectName = useProjectName();
  if (!interaction || interaction.state !== "pending") return null;
  const key = interactionKey(props.threadId, props.interactionId);
  const request = interaction.request;
  const copy =
    request.kind === "approval"
      ? approvalCopy(request, { mode: thread?.permission?.effective })
      : undefined;
  return (
    <FeedRow
      icon={glyph(requestIcons[request.kind])}
      title={
        copy
          ? copy.title
          : privateBrowserGate(interaction)
            ? "You're holding a browser privately"
            : requestTitle(request)
      }
      description={thread ? `${projectName(thread.workspaceId)} · ${thread.title}` : "A thread"}
      age={formatAge(interaction.createdAt, now)}
      mark="needs-you"
      selected={focused === key}
      onSelect={() => (wide ? setFocused(key) : selectItem(key))}
    />
  );
}
