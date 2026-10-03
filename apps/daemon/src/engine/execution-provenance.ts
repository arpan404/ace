import { ExecutionSource, type EventPayload, type ExecutionSelection } from "@ace/protocol";
import type { ThreadState } from "@ace/core";

/** Record ownership when a run starts; never infer it from a later provider selection. */
export function captureExecutionSources(
  state: ThreadState,
  events: readonly EventPayload[],
  selection: ExecutionSelection,
  nativeSessionId: string | undefined,
): void {
  for (const event of events) {
    if (event.type === "run.started") {
      const key = state.indexes.agentKeysById[event.run.agentId];
      const agent = key ? state.agents[key]?.agent : undefined;
      const root = key === state.rootKey;
      const nativeId = root ? nativeSessionId : agent?.native.nativeId;
      if (agent && nativeId) {
        const source = ExecutionSource.parse({
          nativeSessionId: nativeId,
          selection: root
            ? selection
            : {
                provider: agent.native.provider,
                ...(agent.model ? { model: agent.model } : {}),
                ...(agent.native.provider === selection.provider && selection.instanceId
                  ? { instanceId: selection.instanceId }
                  : {}),
                options: {},
              },
        });
        event.run.executionSource = source;
        const stored = state.runs[event.run.id];
        if (stored) stored.executionSource = source;
      }
    } else if (event.type === "item.created" || event.type === "item.updated") {
      const source = event.item.runId ? state.runs[event.item.runId]?.executionSource : undefined;
      if (source) event.item.executionSource = source;
    }
  }
}
