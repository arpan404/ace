import { useInteraction, useItem, useSidebarThread } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { interactionKey } from "./activity-state.tsx";
import { alwaysLabel, approvalChoices, commandRisk } from "./approval.ts";
import {
  ButtonKey,
  CardActions,
  CardError,
  CardFrame,
  CommandBlock,
  OpenThreadAction,
  useCardFocused,
  useOpenThreadKey,
} from "./card-frame.tsx";
import { PlanBody, QuestionBody, requestTitle } from "./question-card.tsx";
import { confirmations, useAnswer } from "./use-answer.ts";

/** One open interaction as a Needs-you card, answerable by mouse or by keyboard. */
export function InteractionCard(props: { threadId: string; interactionId: string }) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const thread = useSidebarThread(props.threadId);
  if (!interaction || interaction.state !== "pending") return null;
  const cardKey = interactionKey(props.threadId, props.interactionId);
  return (
    <CardFrame
      cardKey={cardKey}
      title={requestTitle(interaction.request)}
      context={thread ? `${thread.workspaceId} · ${thread.title}` : props.threadId}
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

function ApprovalBody(props: { interaction: Interaction; cardKey: string }) {
  const { interaction } = props;
  const request = interaction.request;
  const options = request.kind === "approval" ? request.options : [];
  const choices = approvalChoices(options);
  const [always, setAlways] = useState(false);
  const checkboxId = useId();
  const focused = useCardFocused(props.cardKey);
  const { answer, sending, failure } = useAnswer(interaction.id);
  const command = useShellCommand(interaction);
  const risk = command ? commandRisk(command) : undefined;
  const description = request.kind === "approval" ? request.description : undefined;
  const approveOption = always && choices.always ? choices.always : choices.approve;
  const approve = () =>
    approveOption &&
    answer({ kind: "approval", optionId: approveOption.id }, confirmations.approved);
  const deny = () =>
    choices.deny && answer({ kind: "approval", optionId: choices.deny.id }, confirmations.denied);
  const live = focused && !sending;
  useHotkey("a", approve, { enabled: live && !!approveOption });
  useHotkey("d", deny, { enabled: live && !!choices.deny });
  useOpenThreadKey(interaction.threadId, focused);
  return (
    <>
      {command && <CommandBlock command={command} />}
      {(risk || description) && (
        <p className="mt-2.5 text-ui text-muted-foreground">
          {risk && (
            <b
              className={
                risk === "high"
                  ? "mr-[7px] font-medium text-status-failed"
                  : "mr-[7px] font-medium text-status-needs-you"
              }
            >
              {risk === "high" ? "High risk." : "Medium risk."}
            </b>
          )}
          {description}
        </p>
      )}
      <CardActions
        lead={
          choices.always && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                id={checkboxId}
                checked={always}
                onCheckedChange={(checked) => setAlways(checked)}
              />
              <label htmlFor={checkboxId} className="cursor-pointer">
                {alwaysLabel(choices.always)}
              </label>
            </span>
          )
        }
      >
        {sending && (
          <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner /> Sending…
          </span>
        )}
        {choices.deny && (
          <Button variant="ghost" disabled={sending} onClick={deny}>
            Deny
            <ButtonKey>D</ButtonKey>
          </Button>
        )}
        {approveOption && (
          <Button variant="primary" disabled={sending} onClick={approve}>
            Approve
            <ButtonKey primary>A</ButtonKey>
          </Button>
        )}
      </CardActions>
      <CardError message={failure} />
    </>
  );
}

/** The shell command an approval is about, from the tool call that asked. */
function useShellCommand(interaction: Interaction): string | undefined {
  const item = useItem(interaction.threadId, interaction.toolCallId ?? "");
  if (item?.type !== "tool_call" || item.call.detail.kind !== "shell") return undefined;
  return item.call.detail.command;
}
