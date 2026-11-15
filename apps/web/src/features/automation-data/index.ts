/** Automations data: the daemon source, hooks, run intents, conflicts and the Work tab list. No pages, no thread UI. */
export {
  entrySource,
  AutomationError,
  listAutomations,
  automationInbox,
  automationHistory,
  putAutomation,
  removeAutomation,
  setEnabledAutomation,
  retryAutomation,
  runAutomation,
  webhookSecret,
  type AutomationEntry,
  type AutomationLists,
  type RunRequest,
  type WebhookSecretResult,
} from "./automations-source.ts";
export {
  automationsQueryKey,
  inboxLimit,
  useAutomationLists,
  useAutomations,
  useAutomation,
  useAutomationRuns,
  useAutomationHistory,
  useAutomationActions,
} from "./use-automations.ts";
export {
  RunIntent,
  maxRunIntents,
  normalizeDaemonKey,
  loadRunIntents,
  getRunIntent,
  ensureRunIntent,
  clearRunIntent,
} from "./run-intents.ts";
export { staleWriteMessage, staleDeleteMessage } from "./revision-conflicts.ts";
export { NextRun } from "./automation-next-run.tsx";
export {
  sidebarNeedsAttention,
  githubHint,
  triggerErrorCopy,
  scheduleState,
  scheduleStateCopy,
  type TriggerHealth,
  type ScheduleState,
} from "@ace/ui-core/automations";
export { useProjectAutomations, WorkAutomationsLine } from "./work-automations.tsx";
