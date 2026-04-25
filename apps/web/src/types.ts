import type {
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationProposedPlanId,
  OrchestrationProposedPlanSummary,
  ProviderIntegrationCapabilities,
  ProjectIcon as ContractProjectIcon,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  ProjectScript as ContractProjectScript,
  ThreadId,
  ProjectId,
  TurnId,
  MessageId,
  ProviderKind,
  CheckpointRef,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadHandoff,
} from "@ace/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectScript = ContractProjectScript;
export type ProjectIcon = ContractProjectIcon;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
}

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export type ChatAttachment = ChatImageAttachment;

export interface QueuedComposerImageAttachment extends ChatImageAttachment {
  dataUrl: string;
  previewUrl: string;
  file?: File;
}

export interface QueuedTerminalContext {
  id: string;
  createdAt: string;
  terminalId: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface QueuedComposerMessage {
  id: MessageId;
  prompt: string;
  images: QueuedComposerImageAttachment[];
  terminalContexts: QueuedTerminalContext[];
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

export interface QueuedSteerRequest {
  messageId: MessageId;
  baselineWorkLogEntryCount: number;
  interruptRequested: boolean;
}

export interface ChatMessageStreamingTextState {
  chunks: ReadonlyArray<string>;
  previewText: string;
  previewLineCount: number;
  totalLength: number;
  totalLineCount: number;
  truncatedCharCount: number;
  truncatedLineCount: number;
}

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  streamingTextState?: ChatMessageStreamingTextState;
  attachments?: ChatAttachment[];
  turnId?: TurnId | null;
  createdAt: string;
  sequence?: number | undefined;
  completedAt?: string | undefined;
  streaming: boolean;
}

export interface ProposedPlan {
  id: OrchestrationProposedPlanId;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
  createdAt: string;
  updatedAt: string;
}

export type ProposedPlanSummary = OrchestrationProposedPlanSummary;

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: TurnId;
  completedAt: string;
  status?: string | undefined;
  source?: "git-checkpoint" | "provider-native" | "provider-reconstructed" | undefined;
  files: TurnDiffFileChange[];
  diff?: string | undefined;
  checkpointRef?: CheckpointRef | undefined;
  assistantMessageId?: MessageId | undefined;
  checkpointTurnCount?: number | undefined;
}

export interface Project {
  id: ProjectId;
  name: string;
  cwd: string;
  defaultModelSelection: ModelSelection | null;
  icon: ProjectIcon | null;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  archivedAt: string | null;
  scripts: ProjectScript[];
}

export interface Thread {
  id: ThreadId;
  codexThreadId: string | null;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  proposedPlans: ProposedPlan[];
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
  branch: string | null;
  worktreePath: string | null;
  handoff?: ThreadHandoff;
  historyLoaded?: boolean;
  latestProposedPlanSummary: ProposedPlanSummary | null;
  queuedComposerMessages: QueuedComposerMessage[];
  queuedSteerRequest: QueuedSteerRequest | null;
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
}

export interface SidebarThreadSummary {
  id: ThreadId;
  projectId: ProjectId;
  title: string;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  branch: string | null;
  worktreePath: string | null;
  handoff?: ThreadHandoff;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
  isErrorDismissed: boolean;
}

export interface ThreadSession {
  provider: ProviderKind;
  status: SessionPhase | "error" | "closed";
  capabilities?: ProviderIntegrationCapabilities | undefined;
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}
