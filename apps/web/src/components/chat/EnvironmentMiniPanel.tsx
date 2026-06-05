import type {
  GitListBranchesResult,
  GitStatusResult,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@ace/contracts";
import { type ComponentProps, forwardRef, type ReactNode, useState } from "react";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  CheckSquareIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FileDiffIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlugIcon,
  SaveIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { m, type MotionStyle } from "motion/react";

import BranchToolbar from "../BranchToolbar";
import EnvironmentGitSection from "../EnvironmentGitSection";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import {
  isSideChatThread,
  orderSubagentThreadsForHierarchy,
  type SubagentThread,
} from "./subagentThreads";
import type {
  ActiveGoalState,
  ActivePlanState,
  EnvironmentMcpStatus,
  EnvironmentProviderStatus,
} from "../../session-logic";
import { cn } from "~/lib/utils";
import { PANEL_SPRING_TRANSITION } from "~/lib/panelMotion";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  createScratchPadNote,
  EMPTY_SCRATCH_PAD_COLLECTION,
  SCRATCH_PAD_STORAGE_KEY,
  ScratchPadCollectionSchema,
  type ScratchPadCollection,
} from "./scratchPadStore";
import {
  EMPTY_PINNED_MESSAGES,
  PINNED_MESSAGES_STORAGE_KEY,
  PinnedMessagesSchema,
  removePinnedMessageById,
  togglePinnedMessageChecked,
  type PinnedMessage,
  type PinnedMessageNavigationTarget,
  type PinnedMessages,
} from "./pinnedMessagesStore";

function formatDiffCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function EnvironmentPanelGroup(props: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <section className="border-t border-border/45 py-1.5 first:border-t-0 first:pt-0">
      <div className="flex min-h-7 items-center gap-1 px-2">
        <button
          type="button"
          className="-ml-1 inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => props.onOpenChange(!props.open)}
          aria-expanded={props.open}
        >
          <span className="truncate">{props.title}</span>
          <ChevronDownIcon
            className={cn("size-3.5 shrink-0 transition-transform", !props.open && "-rotate-90")}
          />
        </button>
        {props.trailing ? <div className="ml-auto shrink-0">{props.trailing}</div> : null}
      </div>
      {props.open ? <div className="mt-0.5 space-y-1">{props.children}</div> : null}
    </section>
  );
}

type EnvironmentPanelGroupId =
  | "actions"
  | "environment"
  | "goal"
  | "mcp"
  | "notes"
  | "pinnedMessages"
  | "provider"
  | "progress"
  | "sideChats"
  | "subagents";
type EnvironmentPanelGroupOpenState = Record<EnvironmentPanelGroupId, boolean>;

const ENVIRONMENT_PANEL_GROUP_STORAGE_KEY = "ace:environment-mini-panel-groups:v7";

const DEFAULT_ENVIRONMENT_PANEL_GROUP_OPEN_STATE: EnvironmentPanelGroupOpenState = {
  actions: false,
  environment: true,
  goal: true,
  mcp: true,
  notes: false,
  pinnedMessages: false,
  provider: true,
  progress: true,
  sideChats: true,
  subagents: true,
};

const EnvironmentPanelGroupOpenStateSchema = Schema.Struct({
  actions: Schema.Boolean,
  environment: Schema.Boolean,
  goal: Schema.Boolean,
  mcp: Schema.Boolean,
  notes: Schema.Boolean,
  pinnedMessages: Schema.Boolean,
  provider: Schema.Boolean,
  progress: Schema.Boolean,
  sideChats: Schema.Boolean,
  subagents: Schema.Boolean,
});

function resolveEnvironmentPanelGroupOpen(
  state: EnvironmentPanelGroupOpenState,
  groupId: EnvironmentPanelGroupId,
): boolean {
  return state[groupId];
}

function isPinnedSelectionMessage(message: PinnedMessage): boolean {
  return (
    message.kind === "selection" ||
    Boolean(message.selectedText) ||
    message.id.includes(":selection:")
  );
}

function resolvePinnedMessageNavigationTarget(
  message: PinnedMessage,
): PinnedMessageNavigationTarget {
  if (!isPinnedSelectionMessage(message)) return { kind: "message" };
  return {
    kind: "selection",
    selectedText: message.selectedText ?? message.preview,
  };
}

function ProgressStepMarker({ status }: { status: ActivePlanState["steps"][number]["status"] }) {
  if (status === "completed") {
    return (
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/45 text-muted-foreground/70">
        <CheckIcon className="size-2.5" strokeWidth={3} />
      </span>
    );
  }

  if (status === "inProgress") {
    return (
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        <Spinner className="size-3.5" />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "relative inline-flex size-3.5 shrink-0 rounded-full border",
        status === "pending" && "border-muted-foreground/55 bg-transparent",
      )}
    />
  );
}

function formatGoalUsage(goal: ActiveGoalState): string | null {
  if (goal.tokensUsed !== undefined && goal.tokenBudget !== undefined) {
    return `${new Intl.NumberFormat().format(goal.tokensUsed)} / ${new Intl.NumberFormat().format(goal.tokenBudget)} tokens`;
  }
  if (goal.tokensUsed !== undefined) {
    return `${new Intl.NumberFormat().format(goal.tokensUsed)} tokens`;
  }
  if (goal.timeUsedSeconds !== undefined) {
    const minutes = Math.max(1, Math.round(goal.timeUsedSeconds / 60));
    return `${minutes}m elapsed`;
  }
  return null;
}

function GoalControlButton(props: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
            onClick={props.onClick}
            disabled={props.disabled}
            aria-label={props.label}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function EnvironmentGoalPanel(props: {
  goal: ActiveGoalState;
  goalControlsSupported: boolean;
  onDeleteGoal: () => void;
  onEditGoal: (objective: string) => void;
  onPauseGoal: () => void;
  onResumeGoal: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftObjective, setDraftObjective] = useState(props.goal.objective);
  const usage = formatGoalUsage(props.goal);
  const trimmedDraft = draftObjective.trim();
  const saveDisabled = trimmedDraft.length === 0 || trimmedDraft === props.goal.objective;

  if (editing && props.goalControlsSupported) {
    return (
      <div className="space-y-1.5 px-2 py-1">
        <textarea
          value={draftObjective}
          onChange={(event) => setDraftObjective(event.target.value)}
          className="min-h-20 w-full resize-none rounded-lg border border-border/65 bg-background/75 px-2.5 py-2 text-[12px] leading-5 outline-none transition-colors focus:border-ring/55 focus:ring-2 focus:ring-ring/10"
          aria-label="Edit goal objective"
        />
        <div className="flex items-center justify-end gap-1">
          <GoalControlButton
            label="Cancel edit"
            onClick={() => {
              setDraftObjective(props.goal.objective);
              setEditing(false);
            }}
          >
            <XIcon className="size-3.5" />
          </GoalControlButton>
          <GoalControlButton
            label="Save goal"
            disabled={saveDisabled}
            onClick={() => {
              if (saveDisabled) return;
              props.onEditGoal(trimmedDraft);
              setEditing(false);
            }}
          >
            <SaveIcon className="size-3.5" />
          </GoalControlButton>
        </div>
      </div>
    );
  }

  return (
    <div className="px-2 py-1">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="line-clamp-3 text-[12px] leading-5 text-foreground">
            {props.goal.objective}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>{props.goal.status}</span>
            {usage ? (
              <span className="min-w-0 truncate normal-case tracking-normal">{usage}</span>
            ) : null}
          </div>
        </div>
        {props.goalControlsSupported ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {props.goal.status === "paused" ? (
              <GoalControlButton label="Resume goal" onClick={props.onResumeGoal}>
                <PlayIcon className="size-3.5" />
              </GoalControlButton>
            ) : (
              <GoalControlButton label="Pause goal" onClick={props.onPauseGoal}>
                <PauseIcon className="size-3.5" />
              </GoalControlButton>
            )}
            <GoalControlButton
              label="Edit goal"
              onClick={() => {
                setDraftObjective(props.goal.objective);
                setEditing(true);
              }}
            >
              <PencilIcon className="size-3.5" />
            </GoalControlButton>
            <GoalControlButton label="Delete goal" onClick={props.onDeleteGoal}>
              <Trash2Icon className="size-3.5" />
            </GoalControlButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EnvironmentMcpStatusRow({ status }: { status: EnvironmentMcpStatus }) {
  const detail = [status.providerLabel, status.detail].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-7 items-center gap-2 px-2 py-0.5 text-[12px]">
      <PlugIcon
        className={cn(
          "size-3.5 shrink-0",
          status.tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">{status.name}</div>
        {detail ? <div className="truncate text-[10px] text-muted-foreground">{detail}</div> : null}
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide",
          status.tone === "error"
            ? "bg-destructive/12 text-destructive"
            : "bg-muted text-muted-foreground",
        )}
      >
        {status.status}
      </span>
    </div>
  );
}

function EnvironmentProviderStatusRow({ status }: { status: EnvironmentProviderStatus }) {
  return (
    <div className="flex min-h-7 items-center gap-2 px-2 py-0.5 text-[12px]">
      <CircleAlertIcon
        className={cn(
          "size-3.5 shrink-0",
          status.tone === "error"
            ? "text-destructive"
            : status.tone === "warning"
              ? "text-warning"
              : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">{status.label}</div>
        {status.detail ? (
          <div className="truncate text-[10px] text-muted-foreground">{status.detail}</div>
        ) : null}
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide",
          status.tone === "error"
            ? "bg-destructive/12 text-destructive"
            : status.tone === "warning"
              ? "bg-warning/12 text-warning"
              : "bg-muted text-muted-foreground",
        )}
      >
        {status.status}
      </span>
    </div>
  );
}

function hashSubagentIconSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildSubagentIconCells(seed: number): string[] {
  const cells: string[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const bitIndex = row * 3 + column;
      const enabled = ((seed >> bitIndex) & 1) === 1 || (row === 4 && column === 1);
      if (!enabled) continue;
      cells.push(`${column},${row}`);
      const mirroredColumn = 4 - column;
      if (mirroredColumn !== column) {
        cells.push(`${mirroredColumn},${row}`);
      }
    }
  }
  return cells;
}

export function EnvironmentSubagentIcon({
  className,
  thread,
}: {
  className?: string;
  thread: SubagentThread;
}) {
  const isRunning = thread.status === "running";
  const seed = hashSubagentIconSeed(thread.id || thread.label);
  const hue = seed % 360;
  const cells = buildSubagentIconCells(seed);
  const fill = `hsl(${hue} 92% 66%)`;
  const shadowFill = `hsl(${(hue + 24) % 360} 88% 58%)`;
  return (
    <span
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground",
        isRunning && "text-foreground",
        className,
      )}
      aria-label={`${thread.label} subagent icon`}
    >
      <svg
        aria-hidden="true"
        className="subagent-pixel-icon relative size-3 [image-rendering:pixelated]"
        data-running={isRunning ? "true" : "false"}
        viewBox="0 0 5 5"
      >
        {cells.map((cell) => {
          const [x, y] = cell.split(",");
          const shouldUseShadowFill = (Number(x) * 7 + Number(y) * 11 + seed) % 4 === 0;
          return (
            <rect
              key={cell}
              x={x}
              y={y}
              width="1"
              height="1"
              fill={shouldUseShadowFill ? shadowFill : fill}
              style={{ animationDelay: `${((Number(x) + Number(y) * 2 + seed) % 9) * 120}ms` }}
            />
          );
        })}
      </svg>
    </span>
  );
}

function EnvironmentSubagentThreadButton(props: {
  active: boolean;
  depth?: number;
  onClick: () => void;
  thread: SubagentThread;
}) {
  const depth = props.depth ?? 0;
  return (
    <button
      type="button"
      className={cn(
        "group/subagent relative flex min-h-8 w-full items-center gap-2 rounded-lg py-1 pr-2 text-left text-[12px] transition-colors hover:bg-accent hover:text-accent-foreground",
        depth === 0 ? "pl-2" : depth === 1 ? "pl-5" : "pl-7",
        props.active && "bg-accent/70 text-accent-foreground",
      )}
      data-subagent-depth={depth}
      {...(props.thread.parentId ? { "data-subagent-parent-id": props.thread.parentId } : {})}
      onClick={props.onClick}
    >
      {depth > 0 ? (
        <span
          aria-hidden="true"
          className="absolute left-2 top-1/2 h-px w-2 -translate-y-1/2 bg-border/75"
        />
      ) : null}
      <EnvironmentSubagentIcon thread={props.thread} />
      <span className="min-w-0 flex-1 truncate font-medium">{props.thread.label}</span>
    </button>
  );
}

export const EnvironmentMiniPanel = forwardRef<
  HTMLElement,
  {
    activeProjectScripts: ProjectScript[] | undefined;
    activeGoal: ActiveGoalState | null;
    activeGoalControlsSupported: boolean;
    activePlan: ActivePlanState | null;
    activeSubagentThreadId: string | null;
    activeThreadId: ThreadId;
    branchToolbarProps: ComponentProps<typeof BranchToolbar> | null;
    editorStateInstanceId: string;
    gitCwd: string | null;
    gitStatus: GitStatusResult | null;
    gitStatusError: Error | null;
    branchList: GitListBranchesResult | null;
    isGitRepo: boolean;
    keybindings: ResolvedKeybindingsConfig;
    layoutMode: "inline" | "popover";
    mcpStatuses: ReadonlyArray<EnvironmentMcpStatus>;
    providerStatuses: ReadonlyArray<EnvironmentProviderStatus>;
    style?: MotionStyle;
    onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
    onDeleteProjectScript: (scriptId: string) => Promise<void>;
    onDeleteGoal: () => void;
    onEditGoal: (objective: string) => void;
    onOpenDiffPanel: () => void;
    onOpenEnvironmentSettings: () => void;
    onJumpToMessage: (messageId: string, target: PinnedMessageNavigationTarget) => void;
    onOpenSummaryPanel: () => void;
    onRunProjectScript: (script: ProjectScript) => void;
    onPauseGoal: () => void;
    onResumeGoal: () => void;
    onSelectSubagentThread: (threadId: string) => void;
    onSubagentPanelOpen: () => void;
    onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
    onWorkspaceModeChange: (mode: ThreadWorkspaceMode) => void;
    preferredScriptId: string | null;
    subagentThreads: ReadonlyArray<SubagentThread>;
    workspaceChangeStat: { additions: number; deletions: number } | null;
    workspaceMode: ThreadWorkspaceMode;
  }
>(function EnvironmentMiniPanel(props, ref) {
  const [groupOpenState, setGroupOpenState] = useLocalStorage<
    EnvironmentPanelGroupOpenState,
    EnvironmentPanelGroupOpenState
  >(
    ENVIRONMENT_PANEL_GROUP_STORAGE_KEY,
    DEFAULT_ENVIRONMENT_PANEL_GROUP_OPEN_STATE,
    EnvironmentPanelGroupOpenStateSchema,
  );
  const [scratchPadCollection, setScratchPadCollection] = useLocalStorage<
    ScratchPadCollection,
    ScratchPadCollection
  >(SCRATCH_PAD_STORAGE_KEY, EMPTY_SCRATCH_PAD_COLLECTION, ScratchPadCollectionSchema);
  const [pinnedMessages, setPinnedMessages] = useLocalStorage<PinnedMessages, PinnedMessages>(
    PINNED_MESSAGES_STORAGE_KEY,
    EMPTY_PINNED_MESSAGES,
    PinnedMessagesSchema,
  );
  const activeThreadId = String(props.activeThreadId);
  const setGroupOpen = (groupId: EnvironmentPanelGroupId, open: boolean) => {
    setGroupOpenState((current) => ({
      ...DEFAULT_ENVIRONMENT_PANEL_GROUP_OPEN_STATE,
      ...current,
      [groupId]: open,
    }));
  };
  const scratchPadNotes = scratchPadCollection.notes
    .filter((note) => note.threadId === undefined || note.threadId === activeThreadId)
    .toSorted((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 4);
  const activeScratchPadNote =
    scratchPadNotes.find((note) => note.id === scratchPadCollection.activeNoteId) ??
    scratchPadNotes[0] ??
    null;
  const threadPinnedMessages = pinnedMessages
    .filter((message) => message.threadId === activeThreadId)
    .toSorted((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 5);
  const updateActiveScratchPadBody = (body: string) => {
    if (!activeScratchPadNote) {
      const note = createScratchPadNote({
        body,
        threadId: activeThreadId,
        title: "Working scratch",
      });
      setScratchPadCollection((current) => ({
        activeNoteId: note.id,
        notes: [note, ...current.notes],
      }));
      return;
    }
    setScratchPadCollection((current) => ({
      ...current,
      activeNoteId: activeScratchPadNote.id,
      notes: current.notes.map((note) =>
        note.id === activeScratchPadNote.id ? { ...note, body, updatedAt: Date.now() } : note,
      ),
    }));
  };
  const activePlan = props.activePlan;
  const activeGoal = props.activeGoal;
  const activeProjectScripts = props.activeProjectScripts;
  const mcpStatuses = props.mcpStatuses;
  const providerStatuses = props.providerStatuses;
  const subagentThreads = props.subagentThreads;
  const sideChatThreads = subagentThreads.filter(isSideChatThread);
  const providerSubagentThreads = subagentThreads.filter((thread) => !isSideChatThread(thread));
  const workspaceChangeStat = props.workspaceChangeStat;
  const hasChanges =
    workspaceChangeStat !== null &&
    (workspaceChangeStat.additions > 0 || workspaceChangeStat.deletions > 0);
  const isCheckingChanges =
    props.isGitRepo && props.gitStatus === null && props.gitStatusError === null;
  const activeTodoSteps = activePlan?.steps ?? [];

  return (
    <m.aside
      ref={ref}
      className={cn(
        "pointer-events-auto z-50 w-[min(18.5rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl border border-border/70 bg-popover/90 p-2 text-popover-foreground shadow-lg backdrop-blur-xl sm:p-2.5",
        "[overflow-anchor:none]",
        props.layoutMode === "inline"
          ? "absolute top-3 right-3 max-h-[calc(100%_-_1.5rem)]"
          : "fixed max-h-[min(42rem,calc(100vh-1rem))]",
        props.layoutMode === "inline" ? "shadow-black/5" : "shadow-black/10",
      )}
      initial={{ opacity: 0, scale: 0.985, x: 22 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.985, x: 18 }}
      data-slot="environment-mini-panel"
      transition={PANEL_SPRING_TRANSITION}
      {...(props.style ? { style: props.style } : {})}
    >
      <div className="space-y-0">
        {activeGoal ? (
          <EnvironmentPanelGroup
            title="Goal"
            open={resolveEnvironmentPanelGroupOpen(groupOpenState, "goal")}
            onOpenChange={(open) => setGroupOpen("goal", open)}
          >
            <EnvironmentGoalPanel
              goal={activeGoal}
              goalControlsSupported={props.activeGoalControlsSupported}
              onDeleteGoal={props.onDeleteGoal}
              onEditGoal={props.onEditGoal}
              onPauseGoal={props.onPauseGoal}
              onResumeGoal={props.onResumeGoal}
            />
          </EnvironmentPanelGroup>
        ) : null}

        {activeTodoSteps.length > 0 ? (
          <EnvironmentPanelGroup
            title="Progress"
            open={resolveEnvironmentPanelGroupOpen(groupOpenState, "progress")}
            onOpenChange={(open) => setGroupOpen("progress", open)}
          >
            <div className="space-y-0.5">
              {activeTodoSteps.map((step) => (
                <button
                  key={`${step.status}-${step.step}`}
                  type="button"
                  className="flex min-h-7 w-full items-center gap-2 rounded-lg px-2 py-0.5 text-left text-[13px] leading-snug text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground"
                  onClick={props.onOpenSummaryPanel}
                >
                  <ProgressStepMarker status={step.status} />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      step.status === "completed" && "text-muted-foreground/60",
                      step.status === "inProgress" && "text-foreground",
                    )}
                  >
                    {step.step}
                  </span>
                </button>
              ))}
            </div>
          </EnvironmentPanelGroup>
        ) : null}

        <EnvironmentPanelGroup
          title="Environment"
          open={resolveEnvironmentPanelGroupOpen(groupOpenState, "environment")}
          onOpenChange={(open) => setGroupOpen("environment", open)}
          trailing={
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="-mr-1 size-7 shrink-0 rounded-full bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={props.onOpenEnvironmentSettings}
                    aria-label="Open environment settings"
                  />
                }
              >
                <SettingsIcon className="size-4" strokeWidth={2} />
              </TooltipTrigger>
              <TooltipPopup side="left">Environment settings</TooltipPopup>
            </Tooltip>
          }
        >
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[12px] transition-colors hover:bg-accent/60 hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-60"
            disabled={!props.isGitRepo}
            onClick={props.onOpenDiffPanel}
          >
            <FileDiffIcon className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1">Changes</span>
            {isCheckingChanges ? (
              <span className="inline-flex items-center text-muted-foreground">
                <Spinner className="size-3.5" />
                <span className="sr-only">Checking changes</span>
              </span>
            ) : hasChanges && workspaceChangeStat ? (
              <span className="inline-flex min-w-0 shrink-0 items-center gap-1 font-medium tabular-nums">
                {workspaceChangeStat.additions > 0 ? (
                  <span className="text-success">
                    +{formatDiffCount(workspaceChangeStat.additions)}
                  </span>
                ) : null}
                {workspaceChangeStat.deletions > 0 ? (
                  <span className="text-destructive">
                    -{formatDiffCount(workspaceChangeStat.deletions)}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">Clean</span>
            )}
          </button>

          {props.branchToolbarProps ? (
            <BranchToolbar {...props.branchToolbarProps} presentation="environment" />
          ) : null}

          {props.isGitRepo ? (
            <EnvironmentGitSection
              activeThreadId={props.activeThreadId}
              branchList={props.branchList}
              connectionUrl={props.branchToolbarProps?.connectionUrl ?? null}
              editorStateInstanceId={props.editorStateInstanceId}
              gitCwd={props.gitCwd}
              gitStatus={props.gitStatus}
              gitStatusError={props.gitStatusError}
              workspaceMode={props.workspaceMode}
              onWorkspaceModeChange={props.onWorkspaceModeChange}
            />
          ) : props.gitCwd ? (
            <Skeleton className="mx-2 h-8 rounded-lg" />
          ) : null}
        </EnvironmentPanelGroup>

        {providerStatuses.length > 0 ? (
          <EnvironmentPanelGroup
            title="Provider"
            open={resolveEnvironmentPanelGroupOpen(groupOpenState, "provider")}
            onOpenChange={(open) => setGroupOpen("provider", open)}
          >
            <div className="space-y-0.5">
              {providerStatuses.map((status) => (
                <EnvironmentProviderStatusRow key={status.id} status={status} />
              ))}
            </div>
          </EnvironmentPanelGroup>
        ) : null}

        {mcpStatuses.length > 0 ? (
          <EnvironmentPanelGroup
            title="MCP"
            open={resolveEnvironmentPanelGroupOpen(groupOpenState, "mcp")}
            onOpenChange={(open) => setGroupOpen("mcp", open)}
          >
            <div className="space-y-0.5">
              {mcpStatuses.map((status) => (
                <EnvironmentMcpStatusRow key={status.id} status={status} />
              ))}
            </div>
          </EnvironmentPanelGroup>
        ) : null}

        {threadPinnedMessages.length > 0 ? (
          <EnvironmentPanelGroup
            title="Pinned Messages"
            open={resolveEnvironmentPanelGroupOpen(groupOpenState, "pinnedMessages")}
            onOpenChange={(open) => setGroupOpen("pinnedMessages", open)}
          >
            <div className="space-y-0.5 px-2">
              {threadPinnedMessages.map((message) => (
                <div key={message.id} className="flex min-h-7 items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-muted-foreground/50 text-foreground transition-colors hover:text-foreground"
                    onClick={() =>
                      setPinnedMessages((current) =>
                        togglePinnedMessageChecked(current, message.id),
                      )
                    }
                    aria-label={
                      message.checked
                        ? `Mark pinned message incomplete: ${message.title}`
                        : `Mark pinned message complete: ${message.title}`
                    }
                  >
                    {message.checked ? <CheckSquareIcon className="size-3" /> : null}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 truncate text-left text-[12px] transition-colors hover:text-foreground",
                      message.checked ? "text-muted-foreground/55 line-through" : "text-foreground",
                    )}
                    title={message.preview}
                    onClick={() =>
                      props.onJumpToMessage(
                        message.messageId,
                        resolvePinnedMessageNavigationTarget(message),
                      )
                    }
                  >
                    {message.title}
                  </button>
                  <button
                    type="button"
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground"
                    onClick={() =>
                      setPinnedMessages((current) => removePinnedMessageById(current, message.id))
                    }
                    aria-label={`Unpin message: ${message.title}`}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </EnvironmentPanelGroup>
        ) : null}

        {activeProjectScripts ? (
          <EnvironmentPanelGroup
            title="Actions"
            open={resolveEnvironmentPanelGroupOpen(groupOpenState, "actions")}
            onOpenChange={(open) => setGroupOpen("actions", open)}
          >
            <ProjectScriptsControl
              scripts={activeProjectScripts}
              keybindings={props.keybindings}
              preferredScriptId={props.preferredScriptId}
              onRunScript={props.onRunProjectScript}
              onAddScript={props.onAddProjectScript}
              onUpdateScript={props.onUpdateProjectScript}
              onDeleteScript={props.onDeleteProjectScript}
            />
          </EnvironmentPanelGroup>
        ) : null}

        {sideChatThreads.length > 0 ? (
          <EnvironmentPanelGroup
            title="Side chats"
            open={resolveEnvironmentPanelGroupOpen(groupOpenState, "sideChats")}
            onOpenChange={(open) => setGroupOpen("sideChats", open)}
          >
            <div className="space-y-1">
              {sideChatThreads.map((thread) => (
                <EnvironmentSubagentThreadButton
                  key={thread.id}
                  active={props.activeSubagentThreadId === thread.id}
                  thread={thread}
                  onClick={() => {
                    props.onSelectSubagentThread(thread.id);
                    props.onSubagentPanelOpen();
                  }}
                />
              ))}
            </div>
          </EnvironmentPanelGroup>
        ) : null}

        {providerSubagentThreads.length > 0 ? (
          <EnvironmentPanelGroup
            title="Subagents"
            open={resolveEnvironmentPanelGroupOpen(groupOpenState, "subagents")}
            onOpenChange={(open) => setGroupOpen("subagents", open)}
          >
            <div className="space-y-1">
              {orderSubagentThreadsForHierarchy(providerSubagentThreads).map(
                ({ thread, depth }) => (
                  <EnvironmentSubagentThreadButton
                    key={thread.id}
                    active={props.activeSubagentThreadId === thread.id}
                    depth={depth}
                    thread={thread}
                    onClick={() => {
                      props.onSelectSubagentThread(thread.id);
                      props.onSubagentPanelOpen();
                    }}
                  />
                ),
              )}
            </div>
          </EnvironmentPanelGroup>
        ) : null}

        <EnvironmentPanelGroup
          title="Notes"
          open={resolveEnvironmentPanelGroupOpen(groupOpenState, "notes")}
          onOpenChange={(open) => setGroupOpen("notes", open)}
        >
          <div className="space-y-2 px-2 pt-0.5">
            <div className="overflow-hidden rounded-xl border border-border/60 bg-background/70 shadow-[0_1px_0_hsl(var(--foreground)/0.04)] transition-colors focus-within:border-ring/45 focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/10">
              <textarea
                value={activeScratchPadNote?.body ?? ""}
                onChange={(event) => updateActiveScratchPadBody(event.target.value)}
                placeholder="Quick note..."
                className="min-h-24 w-full resize-none bg-transparent px-3 py-3 font-sans text-[12px] leading-5 outline-none placeholder:text-muted-foreground/42"
              />
            </div>
          </div>
        </EnvironmentPanelGroup>
      </div>
    </m.aside>
  );
});
