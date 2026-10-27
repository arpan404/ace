import { useEffect, useMemo, useState } from "react";
import type { ClientApi, ThreadSource } from "@ace/client";
import { approvalCopy } from "@ace/ui-core";
import { useSelection } from "./selection.ts";
import { AceHost, tokens, useTheme } from "./theme.tsx";
import {
  approvalResolution,
  canResolveInteraction,
  clearClosedResolution,
  clearResolutionSending,
  isResolutionLocked,
  markResolutionRefused,
  markResolutionSending,
  markResolutionSent,
  mayAct,
  refusalMessage,
  shellCommandForApproval,
  useResolutionEntry,
} from "./interactions.ts";
import {
  AceText,
  AceButton,
  Column,
  Row,
  padding,
  background,
  clip,
  fillMaxWidth,
} from "./components.tsx";
export function Approval({
  id,
  store,
  client,
  notify,
  canAct,
}: {
  id: string;
  store: ThreadSource;
  client: ClientApi;
  notify(text: string): void;
  /** This device may answer. Absent fails closed to view-only; never default true. */
  canAct?: boolean;
}) {
  const theme = useTheme();
  const selection = useMemo(
    () => store.select([`interaction:${id}`], (r) => r.interaction(id)),
    [store, id],
  );
  const interaction = useSelection(selection);
  const toolCallSelection = useMemo(() => {
    const toolCallId = interaction?.toolCallId ?? "";
    return store.select([`item:${toolCallId}`], (r) => r.item(toolCallId));
  }, [store, interaction?.toolCallId]);
  const toolCall = useSelection(toolCallSelection);
  const resolution = useResolutionEntry(id);
  const [details, setDetails] = useState(false);
  const state = interaction?.state;
  useEffect(() => {
    if (interaction && state !== "pending") clearClosedResolution(interaction.id);
  }, [interaction, state]);
  if (!interaction || state !== "pending" || interaction.request.kind !== "approval") return null;
  const request = interaction.request;
  const command = shellCommandForApproval(toolCall);
  const copy = approvalCopy(request, command !== undefined ? { command } : {});
  const acting = mayAct(canAct);
  const locked = isResolutionLocked(interaction.id);
  const answerable = canResolveInteraction(state, locked, acting);
  const refusal = resolution?.phase === "refused" ? resolution.message : undefined;
  const sending = resolution?.phase === "sending" || resolution?.phase === "sent";
  const hasDetails = copy.reason !== undefined || copy.others.length > 0;
  function resolve(optionId: string) {
    if (
      !interaction ||
      !canResolveInteraction(interaction.state, isResolutionLocked(interaction.id), acting)
    )
      return;
    markResolutionSending(interaction.id);
    if (client.state !== "ready") notify("Will apply when reconnected");
    void client
      .command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: approvalResolution(optionId),
      })
      .then((receipt) => {
        if (!interaction) return;
        if (receipt.ok) {
          markResolutionSent(interaction.id);
          notify("Answer accepted");
          // Keep locked until the daemon closes the interaction (first answer wins).
        } else {
          // A daemon refusal is final: stay shut instead of inviting a retry.
          const message = refusalMessage(receipt.error, "This approval could not be answered");
          markResolutionRefused(interaction.id, message);
          notify(message);
        }
      })
      .catch(() => {
        if (!interaction) return;
        clearResolutionSending(interaction.id);
        notify("Answer could not be saved");
      });
  }
  return (
    <AceHost style={{ width: "100%" }}>
      <Column
        modifiers={[
          fillMaxWidth(),
          clip({ type: "roundedCorner", radius: tokens.radii.approval }),
          background(theme.colours.card),
          padding(tokens.spacing.lg, tokens.spacing.lg, tokens.spacing.lg, tokens.spacing.lg),
        ]}
        verticalArrangement={{ spacedBy: tokens.spacing.md }}
      >
        <AceText role="label" colour={theme.statusText.needsYou}>
          Approval needed
        </AceText>
        <AceText role="title">{copy.heading}</AceText>
        {copy.command ? <AceText role="code">$ {copy.command}</AceText> : null}
        {copy.risk ? (
          <AceText
            role="caption"
            colour={
              copy.risk.level === "high" ? theme.statusText.failed : theme.statusText.needsYou
            }
          >
            {copy.risk.level === "high" ? "High risk" : "Medium risk"} · {copy.risk.text}
          </AceText>
        ) : null}
        {copy.facts.map((fact) => (
          <AceText key={fact.label} role="caption" colour={theme.colours.mutedForeground}>
            {fact.label}: {fact.value}
          </AceText>
        ))}
        {copy.code ? <AceText role="code">{copy.code}</AceText> : null}
        {copy.files.length > 0 ? (
          <Column verticalArrangement={{ spacedBy: tokens.spacing.sm }}>
            <AceText role="caption" colour={theme.colours.mutedForeground}>
              {copy.files.length === 1 ? "1 file" : `${copy.files.length} files`} · every file needs
              this approval
            </AceText>
            {copy.files.map((path) => (
              <AceText key={path} role="code">
                {path}
              </AceText>
            ))}
          </Column>
        ) : null}
        <Row horizontalArrangement={{ spacedBy: tokens.spacing.sm }}>
          {hasDetails ? (
            <AceButton
              label={details ? "Hide details" : "Details"}
              onPress={() => setDetails((open) => !open)}
              kind="secondary"
            />
          ) : null}
          {copy.decisions.map((decision) => (
            <AceButton
              key={decision.option.id}
              label={decision.scope ? `${decision.label}: ${decision.scope}` : decision.label}
              onPress={() => resolve(decision.option.id)}
              enabled={answerable}
              kind={decision.emphasis === "primary" ? "primary" : "secondary"}
            />
          ))}
        </Row>
        {details && copy.reason ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            {copy.reason}
          </AceText>
        ) : null}
        {details
          ? copy.others.map((other) => (
              <AceButton
                key={other.option.id}
                label={other.label}
                onPress={() => resolve(other.option.id)}
                enabled={answerable}
                kind="secondary"
              />
            ))
          : null}
        {!acting ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            View only. Pair with View and act to answer.
          </AceText>
        ) : null}
        {refusal ? (
          <AceText role="caption" colour={theme.statusText.failed}>
            {refusal}
          </AceText>
        ) : null}
        {sending ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            Sending…
          </AceText>
        ) : null}
      </Column>
    </AceHost>
  );
}
