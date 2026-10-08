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
import { automationRunSummary } from "@/features/automations/index.ts";
import { useNow } from "@/lib/time.ts";
import {
  approvalCopy,
  deliberateApproval,
  formatAge,
  privateBrowserGate,
  type ApprovalVerb,
} from "@ace/ui-core";
import { eventKey, interactionKey, useActivityState } from "./activity-state.tsx";
import { FeedRow } from "./feed-row.tsx";
import { useFeedSource, type FeedEvent, type FeedKind } from "./feed-source.ts";
import { requestTitle } from "./question-card.tsx";
import { confirmations, useAnswer } from "./use-answer.ts";
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
  const { focused, setFocused } = useActivityState();
  const { answer, sending } = useAnswer(props.interactionId);
  const now = useNow();
  const projectName = useProjectName();
  if (!interaction || interaction.state !== "pending") return null;
  const key = interactionKey(props.threadId, props.interactionId);
  const request = interaction.request;
  const copy =
    request.kind === "approval"
      ? approvalCopy(request, { mode: thread?.permission?.effective })
      : undefined;
  const verb = (name: ApprovalVerb) => copy?.decisions.find((decision) => decision.verb === name);
  const deny = verb("deny");
  // ace's own tools and default-to-no requests are approved on their card, never from a list.
  const approve = deliberateApproval(request) ? undefined : verb("allow_once");
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
                  answer({ kind: "approval", optionId: approve.option.id }, confirmations.approved)
                }
              >
                {approve.label}
              </Button>
            )}
            {deny && (
              <Button
                size="sm"
                variant="ghost"
                disabled={sending}
                onClick={() =>
                  answer({ kind: "approval", optionId: deny.option.id }, confirmations.denied)
                }
              >
                {deny.label}
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
  const projectName = useProjectName();
  const key = eventKey(event.id);
  const needsYou = event.kind === "escalation";
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
      description={`${projectName(event.project)} · ${event.context}`}
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
      description={automationRunSummary(run)}
      age={formatAge(run.finishedAt ?? run.startedAt, now)}
      mark={props.read ? undefined : "unread"}
      onSelect={select}
    />
  );
}
