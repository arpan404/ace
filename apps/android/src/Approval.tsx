import { useMemo, useState } from "react";
import type { ClientApi, ThreadSource } from "@ace/client";
import { useSelection } from "./selection.ts";
import { AceHost, tokens, useTheme } from "./theme.tsx";
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
}: {
  id: string;
  store: ThreadSource;
  client: ClientApi;
  notify(text: string): void;
}) {
  const theme = useTheme();
  const selection = useMemo(
    () => store.select([`interaction:${id}`], (r) => r.interaction(id)),
    [store, id],
  );
  const interaction = useSelection(selection);
  const [pending, setPending] = useState(false);
  if (!interaction || interaction.state !== "pending" || interaction.request.kind !== "approval")
    return null;
  const request = interaction.request;
  function resolve(optionId: string) {
    if (!interaction) return;
    setPending(true);
    void client
      .command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId },
      })
      .then((receipt) =>
        notify(receipt.ok ? "Answer accepted" : "This approval could not be answered"),
      )
      .catch(() => notify("Answer could not be saved"))
      .finally(() => setPending(false));
    if (client.state !== "ready") notify("Will apply when reconnected");
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
        <AceText role="label" colour={theme.status.needsYou}>
          Approval needed
        </AceText>
        <AceText role="title">{request.title}</AceText>
        {request.description ? <AceText role="code">{request.description}</AceText> : null}
        <Row horizontalArrangement={{ spacedBy: tokens.spacing.sm }}>
          {request.options.map((option) => (
            <AceButton
              key={option.id}
              label={option.label}
              onPress={() => resolve(option.id)}
              enabled={!pending}
              kind={option.kind === "deny" ? "secondary" : "primary"}
            />
          ))}
        </Row>
      </Column>
    </AceHost>
  );
}
