import { useInteraction, useItem, useSidebarThread } from "@ace/client-react";
import { approvalCopy, displayCommand, oneShotNote } from "@ace/ui-core";
import { CheckIcon } from "@phosphor-icons/react";
import type { Interaction } from "@ace/protocol";
import { useId, useState } from "react";
import { ApprovalButtons, ApprovalDetails } from "@/components/approval-details.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { PermissionReviewSummary } from "@/components/permission-review.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { interactionKey } from "./activity-state.tsx";
import { alwaysLabel, commandRisk, offeredChoices } from "./approval.ts";
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
import { useProjectName } from "@/lib/projects.ts";

/**
 * One open interaction as a Needs-you card, answerable by mouse or by keyboard. A deck agent's
 * request names its deck (`context`) and takes the deck decision's card key, so its feed row
 * focuses it.
 */
export function InteractionCard(props: {
  threadId: string;
  interactionId: string;
  context?: string;
  cardKey?: string;
}) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const thread = useSidebarThread(props.threadId);
  const projectName = useProjectName();
  if (!interaction || interaction.state !== "pending") return null;
  const cardKey = props.cardKey ?? interactionKey(props.threadId, props.interactionId);
  return (
    <CardFrame
      cardKey={cardKey}
      title={
        interaction.request.kind === "approval" && approvalCopy(interaction.request).tool
          ? approvalCopy(interaction.request).title
          : requestTitle(interaction.request)
      }
      context={
        props.context ??
        (thread ? `${projectName(thread.workspaceId)} · ${thread.title}` : "A thread")
      }
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
  const request = props.interaction.request;
  if (request.kind === "approval" && approvalCopy(request).tool)
    return <ToolApprovalBody interaction={props.interaction} cardKey={props.cardKey} />;
  return <ProviderApprovalBody interaction={props.interaction} cardKey={props.cardKey} />;
}

/**
 * An ace tool's request (computer use, page scripts, downloads, uploads): its reason, risk and
 * exact target, and every option it offers in order. These ask for a deliberate yes, so only
 * D (deny) has a key.
 */
function ToolApprovalBody(props: { interaction: Interaction; cardKey: string }) {
  const { interaction } = props;
  const request = interaction.request;
  const focused = useCardFocused(props.cardKey);
  const { answer, sending, chosen, failure } = useAnswer(interaction.id);
  if (request.kind !== "approval") return null;
  // ace answers its own tools' requests before any permission mode's one-shot rule, so every
  // option the daemon offered stands.
  const copy = approvalCopy(request);
  const choices = copy.choices;
  const deny = choices.find((choice) => choice.emphasis === "quiet");
  const picked =
    chosen?.kind === "approval"
      ? choices.find((choice) => choice.option.id === chosen.optionId)
      : undefined;
  return (
    <>
      <ApprovalDetails copy={copy} />
      {interaction.review && (
        <PermissionReviewSummary review={interaction.review} className="mt-2.5" />
      )}
      <CardActions>
        {sending ? (
          <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckIcon aria-hidden size={13} className="text-status-done" />
            {picked?.label ?? "Answer"} · sending…
          </span>
        ) : (
          <ApprovalButtons
            choices={choices}
            disabled={sending}
            onChoose={(choice) =>
              answer(
                { kind: "approval", optionId: choice.option.id },
                choice.emphasis === "quiet" ? confirmations.denied : confirmations.approved,
              )
            }
          />
        )}
      </CardActions>
      <DenyKey
        enabled={focused && !sending && deny !== undefined}
        onDeny={() =>
          deny && answer({ kind: "approval", optionId: deny.option.id }, confirmations.denied)
        }
      />
      <CardError message={failure} />
    </>
  );
}

function DenyKey(props: { enabled: boolean; onDeny(): void }) {
  useHotkey("d", props.onDeny, { enabled: props.enabled });
  return null;
}

function ProviderApprovalBody(props: { interaction: Interaction; cardKey: string }) {
  const { interaction } = props;
  const request = interaction.request;
  const options = request.kind === "approval" ? request.options : [];
  const mode = useSidebarThread(interaction.threadId)?.permission?.effective;
  const choices = offeredChoices(options, mode);
  const [always, setAlways] = useState(false);
  const checkboxId = useId();
  const focused = useCardFocused(props.cardKey);
  const { answer, sending, chosen, failure } = useAnswer(interaction.id);
  const picked =
    chosen?.kind === "approval"
      ? options.find((option) => option.id === chosen.optionId)
      : undefined;
  const command = useShellCommand(interaction);
  const risk = command ? commandRisk(command) : undefined;
  const description = request.kind === "approval" ? request.description : undefined;
  const defaultToNo = request.kind === "approval" && request.defaultToNo === true;
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
      {interaction.review && (
        <PermissionReviewSummary review={interaction.review} className="mt-2.5" />
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
            {picked ? (
              <>
                <CheckIcon aria-hidden size={13} className="text-status-done" />
                {picked.label} · sending…
              </>
            ) : (
              <>
                <Spinner /> Sending…
              </>
            )}
          </span>
        )}
        {choices.deny && (
          <Button variant="ghost" disabled={sending} onClick={deny}>
            Deny
            <ButtonKey>D</ButtonKey>
          </Button>
        )}
        {approveOption && (
          // A request that defaults to no never makes approving the filled button.
          <Button
            variant={defaultToNo ? "secondary" : "primary"}
            disabled={sending}
            onClick={approve}
          >
            Approve
            <ButtonKey primary={!defaultToNo}>A</ButtonKey>
          </Button>
        )}
      </CardActions>
      {choices.hidden > 0 && mode && (
        <p className="mt-2 text-xs text-subtle-foreground">{oneShotNote(mode)}</p>
      )}
      <CardError message={failure} />
    </>
  );
}

/** The shell command an approval is about, from the tool call that asked. */
function useShellCommand(interaction: Interaction): string | undefined {
  const item = useItem(interaction.threadId, interaction.toolCallId ?? "");
  if (item?.type !== "tool_call" || item.call.detail.kind !== "shell") return undefined;
  return displayCommand(item.call.detail).command;
}
