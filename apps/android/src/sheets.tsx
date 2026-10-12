import { useMemo } from "react";
import { ModalBottomSheet } from "@expo/ui/jetpack-compose";
import type { ClientApi, ThreadSource } from "@ace/client";
import type { ReactNode } from "react";
import { AceHost, tokens, useTheme } from "./theme.tsx";
import {
  AceText,
  AceButton,
  Column,
  Row,
  Group,
  StatusPill,
  fillMaxWidth,
  padding,
  size,
  clip,
  background,
  Box,
} from "./components.tsx";
import { useSelection } from "./selection.ts";
export function AceSheet({
  title,
  dismiss,
  children,
}: {
  title: string;
  dismiss(): void;
  children: ReactNode;
}) {
  const { colours: c } = useTheme();
  return (
    <AceHost style={{ width: "100%" }}>
      <ModalBottomSheet
        onDismissRequest={dismiss}
        skipPartiallyExpanded
        containerColor={c.background}
        contentColor={c.foreground}
        showDragHandle={false}
      >
        <Column
          modifiers={[
            fillMaxWidth(),
            padding(tokens.spacing.lg, tokens.spacing.sm, tokens.spacing.lg, tokens.spacing.xxl),
          ]}
          verticalArrangement={{ spacedBy: tokens.spacing.lg }}
        >
          <Row horizontalArrangement="center" modifiers={[fillMaxWidth()]}>
            <Box
              modifiers={[
                size(tokens.dimensions.sheetHandleWidth, tokens.dimensions.sheetHandleHeight),
                clip({ type: "roundedCorner", radius: tokens.radii.pill }),
                background(c.subtleForeground),
              ]}
            />
          </Row>
          <Row
            modifiers={[fillMaxWidth()]}
            horizontalArrangement="spaceBetween"
            verticalAlignment="center"
          >
            <AceText role="title">{title}</AceText>
            <AceButton label="Close" onPress={dismiss} kind="secondary" />
          </Row>
          {children}
        </Column>
      </ModalBottomSheet>
    </AceHost>
  );
}
export function AgentsSheet({
  store,
  client,
  dismiss,
  notify,
}: {
  store: ThreadSource;
  client: ClientApi;
  dismiss(): void;
  notify(text: string): void;
}) {
  const theme = useTheme();
  const selection = useMemo(
    () =>
      store.select(["agents", "tasks", "thread"], (r) => ({
        thread: r.thread,
        agents: r.agentIds().map((id) => r.agent(id)),
        tasks: r.taskIds().map((id) => r.task(id)),
      })),
    [store],
  );
  const state = useSelection(selection);
  async function stop() {
    if (!state.thread) return;
    try {
      await client.enqueue({ type: "thread.interrupt", threadId: state.thread.id, cascade: true });
      notify("Stop requested for every agent");
    } catch {
      notify("Stop could not be saved");
    }
  }
  return (
    <AceSheet title="Agents" dismiss={dismiss}>
      <Group>
        {state.agents.slice(0, 24).map((agent) =>
          agent ? (
            <Column key={agent.id}>
              <AceText role="rowTitle">
                {agent.parentId ? "↳ " : ""}
                {agent.name ?? agent.native.provider}
              </AceText>
              <AceText role="caption" colour={theme.colours.mutedForeground}>
                {agent.status.state}
              </AceText>
            </Column>
          ) : null,
        )}
      </Group>
      {state.tasks.length ? (
        <Group>
          <AceText role="label">Running in background</AceText>
          {state.tasks.slice(0, 12).map((task) =>
            task ? (
              <AceText key={task.id}>
                {task.title} · {task.status}
              </AceText>
            ) : null,
          )}
        </Group>
      ) : null}
      <AceButton label="Stop all" onPress={() => void stop()} />
    </AceSheet>
  );
}
export function MachinesSheet({
  client,
  dismiss,
  notify,
}: {
  client: ClientApi;
  dismiss(): void;
  notify(text: string): void;
}) {
  const theme = useTheme();
  const state = useSelection(useMemo(() => client.connectionState(), [client]));
  return (
    <AceSheet title="Machines" dismiss={dismiss}>
      <Group>
        <AceText role="rowTitle">arpan-mbp</AceText>
        <StatusPill
          label={state}
          colour={state === "ready" ? theme.status.done : theme.status.waiting}
        />
      </Group>
      {__DEV__ ? (
        <Group>
          <AceText role="label">Spike controls</AceText>
          <Row horizontalArrangement={{ spacedBy: tokens.spacing.sm }}>
            <AceButton
              label="Go offline"
              onPress={() => {
                client.networkOnline(false);
                notify("Offline. Messages stay saved on this phone.");
              }}
              kind="secondary"
            />
            <AceButton
              label="Reconnect"
              onPress={() => {
                client.networkOnline(true);
                notify("Reconnecting…");
              }}
              kind="secondary"
            />
          </Row>
        </Group>
      ) : null}
    </AceSheet>
  );
}
