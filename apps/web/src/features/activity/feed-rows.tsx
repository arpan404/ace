import { useInteraction, useInteractions, useSidebarThread } from "@ace/client-react";
import type { AutomationRun, InteractionRequest } from "@ace/protocol";
import {
  AtIcon,
  ChatCircleIcon,
  CheckIcon,
  GitMergeIcon,
  ListChecksIcon,
  PlugIcon,
  WarningIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { runSummary } from "@/features/automations/labels.ts";
import { useNow } from "@/lib/time.ts";
import { formatAge } from "@ace/ui-core";
import { eventKey, interactionKey, useActivityState } from "./activity-state.tsx";
import { approvalChoices } from "./approval.ts";
import { FeedRow } from "./feed-row.tsx";
import { useFeedSource, type FeedEvent, type FeedKind } from "./feed-source.ts";
import { requestTitle } from "./question-card.tsx";
import { confirmations, useAnswer } from "./use-answer.ts";

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
  const { focused, setFocused } = useActivityState();
  const { answer, sending } = useAnswer(props.interactionId);
  const now = useNow();
  if (!interaction || interaction.state !== "pending") return null;
  const key = interactionKey(props.threadId, props.interactionId);
  const request = interaction.request;
  const choices = request.kind === "approval" ? approvalChoices(request.options) : undefined;
  const { approve, deny } = choices ?? {};
  return (
    <FeedRow
      icon={glyph(requestIcons[request.kind])}
      title={requestTitle(request)}
      description={thread ? `${thread.workspaceId} · ${thread.title}` : props.threadId}
      age={formatAge(interaction.createdAt, now)}
      mark="needs-you"
      selected={focused === key}
      onSelect={() => setFocused(key)}
      actions={
        approve || deny ? (
          <>
            {approve && (
              <Button
                size="sm"
                variant="primary"
                disabled={sending}
                onClick={() =>
                  answer({ kind: "approval", optionId: approve.id }, confirmations.approved)
                }
              >
                Approve
              </Button>
            )}
            {deny && (
              <Button
                size="sm"
                variant="ghost"
                disabled={sending}
                onClick={() =>
                  answer({ kind: "approval", optionId: deny.id }, confirmations.denied)
                }
              >
                Deny
              </Button>
            )}
          </>
        ) : undefined
      }
    />
  );
}

const eventIcons: Record<FeedKind, PhosphorIcon> = {
  escalation: WarningIcon,
  mention: AtIcon,
  ci: XIcon,
  pr: GitMergeIcon,
};

/** Mentions, CI and pull-request events open their thread; escalations focus their card. */
export function EventRow(props: { event: FeedEvent; read: boolean }) {
  const { event } = props;
  const { focused, setFocused } = useActivityState();
  const source = useFeedSource();
  const navigate = useNavigate();
  const now = useNow();
  const key = eventKey(event.id);
  const needsYou = event.kind === "escalation" && !event.resolved;
  const select = () => {
    source.markRead([event.id]);
    if (needsYou) setFocused(key);
    else if (event.threadId)
      void navigate({ to: "/t/$threadId", params: { threadId: event.threadId } });
  };
  return (
    <FeedRow
      icon={glyph(eventIcons[event.kind])}
      title={event.title}
      description={`${event.project} · ${event.context}`}
      age={formatAge(event.at, now)}
      mark={needsYou ? "needs-you" : props.read ? undefined : "unread"}
      selected={needsYou && focused === key}
      onSelect={select}
    />
  );
}

/** An automation's run: its outcome mark, what it found, and a way into its thread. */
export function RunRow(props: { run: AutomationRun; read: boolean }) {
  const { run } = props;
  const source = useFeedSource();
  const navigate = useNavigate();
  const now = useNow();
  const select = () => {
    source.markRead([run.id]);
    if (run.threadId) void navigate({ to: "/t/$threadId", params: { threadId: run.threadId } });
    else
      void navigate({
        to: "/automations/$automationId",
        params: { automationId: run.automationId },
      });
  };
  return (
    <FeedRow
      icon={
        run.status === "running" ? (
          <Spinner />
        ) : (
          glyph(run.status === "failed" ? WarningIcon : CheckIcon)
        )
      }
      title={run.title}
      description={runSummary(run)}
      age={formatAge(run.finishedAt ?? run.startedAt, now)}
      mark={props.read ? undefined : "unread"}
      onSelect={select}
    />
  );
}
