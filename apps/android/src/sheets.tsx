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
import { useSelection, sameIds } from "./selection.ts";
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
                background(c.decoration),
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
function AgentRow({ store, id }: { store: ThreadSource; id: string }) {
  const theme = useTheme();
  const agent = useSelection(
    useMemo(() => store.select([`agent:${id}`], (r) => r.agent(id)), [store, id]),
  );
  return agent ? (
    <Column>
      <AceText role="rowTitle">
        {agent.parentId ? "↳ " : ""}
        {agent.name ?? agent.native.provider}
      </AceText>
      <AceText role="caption" colour={theme.colours.mutedForeground}>
        {agent.status.state}
      </AceText>
    </Column>
  ) : null;
}
function TaskRow({ store, id }: { store: ThreadSource; id: string }) {
  const task = useSelection(
    useMemo(() => store.select([`task:${id}`], (r) => r.task(id)), [store, id]),
  );
  return task ? (
    <AceText>
      {task.title} · {task.status}
    </AceText>
  ) : null;
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
  const agents = useSelection(
    useMemo(() => store.select(["agents"], (r) => r.agentIds(), sameIds), [store]),
  );
  const tasks = useSelection(
    useMemo(() => store.select(["tasks"], (r) => r.taskIds(), sameIds), [store]),
  );
  const thread = useSelection(useMemo(() => store.select(["thread"], (r) => r.thread), [store]));
  async function stop() {
    if (!thread) return;
    try {
      await client.enqueue({ type: "thread.interrupt", threadId: thread.id, cascade: true });
      notify("Stop requested for every agent");
    } catch {
      notify("Stop could not be saved");
    }
  }
  return (
    <AceSheet title="Agents" dismiss={dismiss}>
      <Group>
        {agents.slice(0, 24).map((id) => (
          <AgentRow key={id} store={store} id={id} />
        ))}
      </Group>
      {tasks.length ? (
        <Group>
          <AceText role="label">Running in background</AceText>
          {tasks.slice(0, 12).map((id) => (
            <TaskRow key={id} store={store} id={id} />
          ))}
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
          markerColour={state === "ready" ? theme.status.done : theme.status.waiting}
          textColour={state === "ready" ? theme.statusText.done : theme.statusText.waiting}
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
