// SPDX-License-Identifier: Apache-2.0
//! A valid payload of each canonical variant with a plan, every optional field given.
//! Moved from `canonical-event.test.ts` so the fold vectors (phase 5.1) reuse the same table.

export const samples: Record<string, Record<string, unknown>> = {
  "input.admitted": {
    type: "input.admitted",
    agentId: "agent-1",
    nativeInputId: "native-1",
    commandId: "command-1",
  },
  "item.delta": {
    type: "item.delta",
    itemId: "item-1",
    agentId: "agent-1",
    field: "text",
    append: '{"index":3,"sentAt":1700000000000}\n',
  },
  "item.deleted": { type: "item.deleted", itemId: "item-1" },
  "background_task.updated": {
    type: "background_task.updated",
    taskId: "task-1",
    status: "completed",
    endedAt: 1_700_000_000_500,
  },
  "context.sampled": {
    type: "context.sampled",
    agentId: "agent-1",
    usedTokens: 1200,
    windowTokens: 200_000,
    sessionId: "session-1",
    model: "model-1",
  },
};
