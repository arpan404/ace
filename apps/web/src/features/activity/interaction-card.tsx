import { useInteraction, useItem, useSidebarThread } from "@ace/client-react";
import { approvalByKey, approvalCopy, displayCommand } from "@ace/ui-core";
import { CheckIcon } from "@phosphor-icons/react";
import type { Interaction } from "@ace/protocol";
import { useState } from "react";
import { ApprovalHeading, ApprovalRequest } from "@/components/approval-request.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { interactionKey } from "./activity-state.tsx";
import {
  CardError,
  CardFrame,
  OpenThreadAction,
  useCardFocused,
  useOpenThreadKey,
} from "./card-frame.tsx";
import { PlanBody, QuestionBody, requestTitle } from "./question-card.tsx";
import { confirmations, useAnswer } from "./use-answer.ts";
import { useProjectName } from "@/lib/projects.ts";

/** One open interaction as a Needs-you card, answerable by mouse or by keyboard. */
export function InteractionCard(props: {
  threadId: string;
  interactionId: string;
  cardKey?: string;
  expanded?: boolean;
}) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const thread = useSidebarThread(props.threadId);
  const projectName = useProjectName();
  if (!interaction || interaction.state !== "pending") return null;
  const cardKey = props.cardKey ?? interactionKey(props.threadId, props.interactionId);
  const request = interaction.request;
  return (
    <CardFrame
      cardKey={cardKey}
      expanded={props.expanded ?? false}
      title={request.kind === "approval" ? approvalCopy(request).title : requestTitle(request)}
      heading={request.kind === "approval" && <Heading interaction={interaction} />}
      context={thread ? `${projectName(thread.workspaceId)} · ${thread.title}` : "A thread"}
      at={interaction.createdAt}
    >
      <CardBody interaction={interaction} cardKey={cardKey} />
    </CardFrame>
  );
}

function CardBody(props: { interaction: Interaction; cardKey: string }) {
  const { interaction } = props;
  switch (interaction.request.kind) {
    case "approval":
      return <ApprovalBody interaction={interaction} cardKey={props.cardKey} />;
    case "question":
      return <QuestionBody interaction={interaction} cardKey={props.cardKey} />;
    case "plan_review":
      return <PlanBody interaction={interaction} cardKey={props.cardKey} />;
    case "elicitation":
      return (
        <>
          <p className="text-[13.5px] leading-normal text-muted-foreground">
            {interaction.request.server} is asking for input that has to be given in the thread.
          </p>
          <OpenThreadAction threadId={interaction.threadId} cardKey={props.cardKey} />
        </>
      );
  }
}

/**
 * An approval: the shared card body (Allow once, Always allow, Deny). A takes the one-shot grant
 * and D denies, except that a request asking for a deliberate yes (ace's own tools, anything
 * that defaults to no) is approved only by a click.
 */
function ApprovalBody(props: { interaction: Interaction; cardKey: string }) {
  const { interaction } = props;
  const request = interaction.request;
  const mode = useSidebarThread(interaction.threadId)?.permission?.effective;
  const command = useShellCommand(interaction);
  const focused = useCardFocused(props.cardKey);
  const { answer, sending, chosen, failure } = useAnswer(interaction.id);
  const [nudged, setNudged] = useState(false);
  const copy =
    request.kind === "approval"
      ? approvalCopy(request, { mode, command, review: interaction.review })
      : undefined;
  const once = copy?.decisions.find((decision) => decision.verb === "allow_once");
  const deny = copy?.decisions.find((decision) => decision.verb === "deny");
  const keyApproves =
    !!once && request.kind === "approval" && !copy?.tool && approvalByKey(request, once.option);
  const live = focused && !sending;
  const decide = (option: { id: string; kind: string }) =>
    answer(
      { kind: "approval", optionId: option.id },
      option.kind === "deny" || option.kind === "deny_always" || option.kind === "cancel"
        ? confirmations.denied
        : confirmations.approved,
    );
  useHotkey("a", () => (keyApproves && once ? decide(once.option) : setNudged(true)), {
    enabled: live && !!once,
  });
  useHotkey("d", () => deny && decide(deny.option), { enabled: live && !!deny });
  useOpenThreadKey(interaction.threadId, focused);
  if (!copy) return null;
  const picked =
    chosen?.kind === "approval"
      ? copy.decisions.find((decision) => decision.option.id === chosen.optionId)?.label
      : undefined;
  return (
    <>
      <ApprovalRequest
        copy={copy}
        review={interaction.review}
        disabled={sending}
        keyed={(option) => option.id !== once?.option.id || keyApproves}
        onAnswer={(choice) => decide(choice.option)}
        answered={
          sending && (
            <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckIcon aria-hidden size={13} className="text-status-done" />
              {picked ?? "Answer"} · sending…
            </span>
          )
        }
      />
      {nudged && !sending && once && (
        <p role="status" className="mt-2 text-xs text-subtle-foreground">
          This request defaults to no: click {once.label} to allow it.
        </p>
      )}
      <CardError message={failure} />
    </>
  );
}

/** An approval's heading, which leaves the command it runs to the body's block. */
function Heading(props: { interaction: Interaction }) {
  const request = props.interaction.request;
  const command = useShellCommand(props.interaction);
  if (request.kind !== "approval") return null;
  return <ApprovalHeading copy={approvalCopy(request, { command })} />;
}

/** The shell command an approval is about, from the tool call that asked. */
function useShellCommand(interaction: Interaction): string | undefined {
  const item = useItem(interaction.threadId, interaction.toolCallId ?? "");
  if (item?.type !== "tool_call" || item.call.detail.kind !== "shell") return undefined;
  return displayCommand(item.call.detail).command;
}
