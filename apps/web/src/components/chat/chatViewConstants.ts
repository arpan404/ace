// ChatView constants module.

import type {
  ApprovalRequestId,
  MessageId,
  OrchestrationThreadActivity,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@ace/contracts";
import type { PullRequestDialogState } from "~/lib/chat/chatView";
import type { TimelineDisclosureExpansionState } from "~/lib/chat/timelineDisclosureState";
import type { TimelineRow } from "~/lib/chat/timelineRows";
import type { ModelSelectionByProvider } from "../../composerDraftStore";
import type { PendingComposerComment } from "../../lib/chat/commentAccumulation";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage, ProposedPlan, Thread } from "../../types";

interface LocalDiffState {
  filePath: string | null;
  open: boolean;
  turnId: TurnId | null;
}

interface PendingPullRequestSetupRequest {
  threadId: ThreadId;
  worktreePath: string;
  scriptId: string;
}

interface ChatViewDialogState {
  gitHubIssueDialogOpen: boolean;
  gitHubIssueDialogInitialIssueNumber: number | null;
  gitHubIssueDialogInitialSelectedIssueNumbers: number[];
  issuePreviewNumber: number | null;
  pullRequestDialogState: PullRequestDialogState | null;
  pendingPullRequestSetupRequest: PendingPullRequestSetupRequest | null;
}

interface ChatViewTransientState {
  localDiffStateByThreadId: Record<ThreadId, LocalDiffState>;
  localDraftErrorsByThreadId: Record<ThreadId, string | null>;
  respondingRequestIds: ApprovalRequestId[];
  respondingUserInputRequestIds: ApprovalRequestId[];
  pendingUserInputAnswersByRequestId: Record<string, Record<string, PendingUserInputDraftAnswer>>;
  pendingUserInputQuestionIndexByRequestId: Record<string, number>;
  expandedWorkGroupsByThreadId: Record<ThreadId, TimelineDisclosureExpansionState>;
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  pendingComposerCommentsByThreadId: Record<ThreadId, PendingComposerComment[]>;
}

export const WORKSPACE_SIDE_PANEL_TRANSITION = {
  opacity: { duration: 0.16, ease: [0.16, 1, 0.3, 1] },
  width: { duration: 0 },
  x: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
} as const;

export const PANEL_OPACITY_SPRING_ANIMATION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const;

export const PANEL_RESIZE_LAYOUT_TRANSITION = {
  height: { duration: 0 },
  opacity: { duration: 0 },
  width: { duration: 0 },
} as const;

export const PANEL_EDGE_LAYOUT_TRANSITION = {
  height: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
  width: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
} as const;

const RESIZABLE_PANEL_WIDTH_CSS_VAR = "--ace-resizable-panel-width";
const RESIZABLE_PANEL_HEIGHT_CSS_VAR = "--ace-resizable-panel-height";

export const RESIZABLE_PANEL_WIDTH_STYLE = {
  flexBasis: `var(${RESIZABLE_PANEL_WIDTH_CSS_VAR})`,
  minWidth: `var(${RESIZABLE_PANEL_WIDTH_CSS_VAR})`,
  width: `var(${RESIZABLE_PANEL_WIDTH_CSS_VAR})`,
} as const;

export const RESIZABLE_PANEL_HEIGHT_STYLE = {
  height: `var(${RESIZABLE_PANEL_HEIGHT_CSS_VAR})`,
} as const;

export const RIGHT_EDGE_PANEL_SPRING_ANIMATION = {
  initial: { scale: 0.985, x: 22 },
  animate: { scale: 1, x: 0 },
  exit: { scale: 0.985, x: 18 },
} as const;

export const BOTTOM_EDGE_PANEL_SPRING_ANIMATION = {
  initial: { scale: 0.985, y: 22 },
  animate: { scale: 1, y: 0 },
  exit: { scale: 0.985, y: 18 },
} as const;

export const PANEL_CONTENT_DEFER_FALLBACK_MS = 420;
export const PANEL_CONTENT_MOUNT_DEFER_AFTER_MOTION_MS = 240;
export const ENVIRONMENT_MINI_PANEL_WIDTH_PX = 336;
export const ENVIRONMENT_MINI_PANEL_MIN_CHAT_WIDTH_PX = 620;
export const ENVIRONMENT_MINI_PANEL_INLINE_INSET_PX = 12;
export const ENVIRONMENT_MINI_PANEL_MIN_GAP_PX = 16;
export const ENVIRONMENT_MINI_PANEL_MAX_GAP_PX = 36;

export const ENVIRONMENT_POPOVER_INTERACTIVE_LAYER_SELECTOR = [
  '[data-slot="alert-dialog-content"]',
  '[data-slot="alert-dialog-overlay"]',
  '[data-slot="combobox-positioner"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="dialog-backdrop"]',
  '[data-slot="dialog-popup"]',
  '[data-slot="dialog-viewport"]',
  '[data-slot="menu-positioner"]',
  '[data-slot="menu-popup"]',
  '[data-slot="popover-positioner"]',
  '[data-slot="popover-popup"]',
  '[data-slot="select-positioner"]',
  '[data-slot="select-popup"]',
].join(",");

export const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
export const CACHED_BROWSER_INSTANCE_TTL_MS = 300_000;

export const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

export const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
export const EMPTY_PROVIDER_STATUSES: ReadonlyArray<ServerProvider> = [];
export const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
export const EMPTY_QUEUED_COMPOSER_MESSAGES: Thread["queuedComposerMessages"] = [];
export const OPTIMISTIC_QUEUE_STATE_MAX_AGE_MS = 2_000;
export const EMPTY_COMPOSER_MODEL_SELECTIONS: ModelSelectionByProvider = Object.freeze({});
export const EMPTY_PENDING_COMPOSER_COMMENTS: readonly PendingComposerComment[] = Object.freeze([]);
export const EMPTY_MESSAGE_ID_SET: Set<MessageId> = new Set();
export const EMPTY_MESSAGE_TURN_COUNT_MAP: Map<MessageId, number> = new Map();
export const EMPTY_TIMELINE_ENTRIES: TimelineEntry[] = [];
export const EMPTY_TIMELINE_ROWS: readonly TimelineRow[] = [];
export const EMPTY_TIMELINE_DISCLOSURE_EXPANSION_STATE: TimelineDisclosureExpansionState = {};
export const EMPTY_CHAT_MESSAGES: readonly ChatMessage[] = Object.freeze([]);
export const EMPTY_PROPOSED_PLANS: readonly ProposedPlan[] = Object.freeze([]);

export const THREAD_SWITCH_SCROLL_SETTLE_DELAY_MS = 96;
export const INITIAL_THREAD_BOTTOM_PIN_MAX_MS = 4_500;
export const INITIAL_THREAD_BOTTOM_PIN_MIN_MS = 900;
export const INITIAL_THREAD_BOTTOM_PIN_STABLE_FRAMES = 20;

export const SCRIPT_TERMINAL_COLS = 120;
export const SCRIPT_TERMINAL_ROWS = 30;
const MIN_BOTTOM_PANEL_HEIGHT = 180;
const MAX_BOTTOM_PANEL_HEIGHT_RATIO = 0.75;

export const BROWSER_BRIDGE_CONTROLLER_WAIT_MS = 5_000;
export const BROWSER_BRIDGE_CONTROLLER_POLL_MS = 50;

export const EMPTY_CHAT_VIEW_DIALOG_STATE: ChatViewDialogState = {
  gitHubIssueDialogOpen: false,
  gitHubIssueDialogInitialIssueNumber: null,
  gitHubIssueDialogInitialSelectedIssueNumbers: [],
  issuePreviewNumber: null,
  pullRequestDialogState: null,
  pendingPullRequestSetupRequest: null,
};

export const EMPTY_CHAT_VIEW_TRANSIENT_STATE: ChatViewTransientState = {
  localDiffStateByThreadId: {},
  localDraftErrorsByThreadId: {},
  respondingRequestIds: [],
  respondingUserInputRequestIds: [],
  pendingUserInputAnswersByRequestId: {},
  pendingUserInputQuestionIndexByRequestId: {},
  expandedWorkGroupsByThreadId: {},
  attachmentPreviewHandoffByMessageId: {},
  pendingComposerCommentsByThreadId: {},
};

const SOURCE_TIMELINE_ROWS_CONTENT_KEY_TAIL_ROWS = 32;
export const ACTIVE_SOURCE_TIMELINE_ROWS_REBUILD_DELAY_MS = 16;

export const RECENT_HYDRATED_THREAD_HISTORY_KEEP_COUNT = 8;

export const INTERRUPT_STOP_FALLBACK_DELAY_MS = 3_000;

export const DEFAULT_LOCAL_DIFF_STATE: LocalDiffState = {
  filePath: null,
  open: false,
  turnId: null,
};

export const EMPTY_VISIBLE_BOARD_THREAD_IDS: readonly ThreadId[] = [];
export const EMPTY_THREAD_LAST_VISITED_AT_BY_ID: Readonly<Record<string, string>> = {};
export const EMPTY_HISTORICAL_MESSAGE_IDS: Set<MessageId> = new Set();
