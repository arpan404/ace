import { useMemo, useState } from "react";
import type { ClientApi, ThreadSource } from "@ace/client";
import { approvalCopy } from "@ace/ui-core";
import { useSelection } from "./selection.ts";
import { AceHost, tokens, useTheme } from "./theme.tsx";
import { approvalResolution, canResolveInteraction } from "./interactions.ts";
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
  canAct = true,
}: {
  id: string;
  store: ThreadSource;
  client: ClientApi;
  notify(text: string): void;
  canAct?: boolean;
}) {
  const theme = useTheme();
  const selection = useMemo(
    () => store.select([`interaction:${id}`], (r) => r.interaction(id)),
    [store, id],
  );
  const interaction = useSelection(selection);
  const [sending, setSending] = useState(false);
  const [details, setDetails] = useState(false);
  if (!interaction || interaction.state !== "pending" || interaction.request.kind !== "approval")
    return null;
  const request = interaction.request;
  const copy = approvalCopy(request);
  const answerable = canResolveInteraction(interaction.state, sending, canAct);
  const hasDetails = copy.reason !== undefined || copy.others.length > 0;
  function resolve(optionId: string) {
    if (!canResolveInteraction(interaction?.state ?? "", sending, canAct) || !interaction) return;
    setSending(true);
    if (client.state !== "ready") notify("Will apply when reconnected");
    void client
      .command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: approvalResolution(optionId),
      })
      .then((receipt) => {
        if (receipt.ok) {
          notify("Answer accepted");
          // Keep disabled until the daemon closes the interaction (first answer wins).
        } else {
          setSending(false);
          notify("This approval could not be answered");
        }
      })
      .catch(() => {
        setSending(false);
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
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            {copy.files.length === 1 ? "1 file" : `${copy.files.length} files`} ·{" "}
            {copy.files.slice(0, 3).join(", ")}
            {copy.files.length > 3 ? "…" : ""}
          </AceText>
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
        {!canAct ? (
          <AceText role="caption" colour={theme.colours.mutedForeground}>
            View only. Pair with View and act to answer.
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
