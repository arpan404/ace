import type { ThreadId } from "@ace/contracts";
import * as Schema from "effect/Schema";

export type EnvironmentPanelGroupId =
  | "actions"
  | "environment"
  | "notes"
  | "pinnedMessages"
  | "progress"
  | "subagents";

export type EnvironmentPanelGroupOpenState = Record<EnvironmentPanelGroupId, boolean>;

export const EnvironmentPanelGroupOpenStateSchema = Schema.Struct({
  actions: Schema.Boolean,
  environment: Schema.Boolean,
  notes: Schema.Boolean,
  pinnedMessages: Schema.Boolean,
  progress: Schema.Boolean,
  subagents: Schema.Boolean,
});

export function resolveEnvironmentPanelGroupStorageKey(threadId: ThreadId): string {
  return `ace:environment-mini-panel-groups:v3:${threadId}`;
}
