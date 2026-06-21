import type {
  GitListBranchesResult,
  GitStatusResult,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@ace/contracts";
import { type ComponentProps, type ReactNode, type Ref } from "react";
import {
  CheckIcon,
  CheckSquareIcon,
  ChevronDownIcon,
  FileDiffIcon,
  GitBranchPlusIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import { m, type MotionStyle } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import BranchToolbar from "../BranchToolbar";
import EnvironmentGitSection from "../EnvironmentGitSection";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import type { SubagentThread } from "./subagentThreads";
import type { ActivePlanState } from "../../session-logic";
import { cn } from "~/lib/utils";
import { PANEL_SPRING_TRANSITION } from "~/lib/panelMotion";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { gitInitMutationOptions } from "~/lib/gitReactQuery";
import { toastManager } from "../ui/toast";
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
import {
  EnvironmentPanelGroupOpenStateSchema,
  resolveEnvironmentPanelGroupStorageKey,
  type EnvironmentPanelGroupId,
  type EnvironmentPanelGroupOpenState,
} from "./environmentMiniPanelState";

const diffCountFormatter = new Intl.NumberFormat();

function formatDiffCount(value: number): string {
  return diffCountFormatter.format(value);
}

const ENVIRONMENT_PANEL_ROW_CLASS_NAME =
  "flex min-h-8 w-full items-center gap-2 rounded-[var(--control-radius)] px-2 py-1 text-left text-[13px] text-foreground/82 transition-colors duration-150 hover:bg-black/[0.045] hover:text-foreground disabled:pointer-events-none disabled:opacity-60 dark:hover:bg-white/[0.09]";

const ENVIRONMENT_PANEL_SURFACE_CLASS_NAME =
  "rounded-[1.625rem] border border-border/35 bg-[color:color-mix(in_oklch,var(--popover)_98%,var(--background)_2%)] text-popover-foreground shadow-[0_26px_70px_-48px_rgb(0_0_0/.36),0_10px_30px_-26px_rgb(0_0_0/.22)] transition-[background-color,border-color] duration-150 supports-[backdrop-filter]:backdrop-blur-2xl supports-[backdrop-filter]:backdrop-saturate-[1.16] dark:border-border/36 dark:bg-[color:color-mix(in_oklch,var(--popover)_94%,var(--background)_6%)] dark:shadow-[0_24px_70px_-46px_rgb(0_0_0/.82),0_10px_32px_-28px_rgb(0_0_0/.62)]";

function EnvironmentPanelGroup(props: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <section className="border-t border-border/35 py-1.5 first:border-t-0 first:pt-0">
      <div className="flex min-h-7 items-center gap-1 px-2">
        <button
          type="button"
          className="-ml-1 inline-flex min-w-0 items-center gap-1 rounded-[var(--control-radius)] px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/76 transition-colors duration-150 hover:bg-black/[0.045] hover:text-foreground dark:hover:bg-white/[0.09]"
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

const DEFAULT_ENVIRONMENT_PANEL_GROUP_OPEN_STATE: EnvironmentPanelGroupOpenState = {
  actions: false,
  environment: true,
  notes: false,
  pinnedMessages: false,
  progress: true,
  subagents: false,
};

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

function EnvironmentSubagentIcon({ thread }: { thread: SubagentThread }) {
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
      )}
    >
      <svg
        aria-hidden="true"
        className="relative size-3 [image-rendering:pixelated]"
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
            />
          );
        })}
      </svg>
    </span>
  );
}

function EnvironmentPinnedMessagesGroup({
  messages,
  onJumpToMessage,
  open,
  onOpenChange,
  setPinnedMessages,
}: {
  messages: PinnedMessage[];
  onJumpToMessage: (messageId: string, target: PinnedMessageNavigationTarget) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setPinnedMessages: (updater: (current: PinnedMessages) => PinnedMessages) => void;
}) {
  if (messages.length === 0) {
    return null;
  }

  return (
    <EnvironmentPanelGroup title="Pinned Messages" open={open} onOpenChange={onOpenChange}>
      <div className="space-y-0.5 px-2">
        {messages.map((message) => (
          <div key={message.id} className="flex min-h-7 items-center gap-2">
            <button
              type="button"
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-[calc(var(--control-radius)-3px)] border border-muted-foreground/50 text-foreground transition-colors hover:text-foreground"
              onClick={() =>
                setPinnedMessages((current) => togglePinnedMessageChecked(current, message.id))
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
                onJumpToMessage(message.messageId, resolvePinnedMessageNavigationTarget(message))
              }
            >
              {message.title}
            </button>
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-[calc(var(--control-radius)-2px)] text-muted-foreground/70 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
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
  );
}

function EnvironmentNotesGroup({
  body,
  open,
  onBodyChange,
  onOpenChange,
}: {
  body: string;
  open: boolean;
  onBodyChange: (body: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <EnvironmentPanelGroup title="Notes" open={open} onOpenChange={onOpenChange}>
      <div className="space-y-2 px-2 pt-0.5">
        <div className="glass-inset overflow-hidden rounded-[var(--control-radius)] border border-border/50 transition-colors focus-within:border-ring/45 focus-within:ring-2 focus-within:ring-ring/10">
          <textarea
            value={body}
            aria-label="Scratchpad note"
            onChange={(event) => onBodyChange(event.target.value)}
            placeholder="Quick note..."
            className="min-h-24 w-full resize-none bg-transparent px-3 py-3 font-sans text-[12px] leading-5 outline-none placeholder:text-muted-foreground/42"
          />
        </div>
      </div>
    </EnvironmentPanelGroup>
  );
}

type EnvironmentMiniPanelProps = {
  activeProjectScripts: ProjectScript[] | undefined;
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
  ref?: Ref<HTMLElement>;
  style?: MotionStyle;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onOpenDiffPanel: () => void;
  onOpenEnvironmentSettings: () => void;
  onJumpToMessage: (messageId: string, target: PinnedMessageNavigationTarget) => void;
  onOpenSummaryPanel: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onSelectSubagentThread: (threadId: string) => void;
  onSubagentPanelOpen: () => void;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onWorkspaceModeChange: (mode: ThreadWorkspaceMode) => void;
  preferredScriptId: string | null;
  subagentThreads: ReadonlyArray<SubagentThread>;
  workspaceChangeStat: { additions: number; deletions: number } | null;
  workspaceMode: ThreadWorkspaceMode;
};

export function EnvironmentMiniPanel({ ref, ...props }: EnvironmentMiniPanelProps) {
  const activeThreadId = String(props.activeThreadId);
  const queryClient = useQueryClient();
  const initMutation = useMutation(
    gitInitMutationOptions({
      connectionUrl: props.branchToolbarProps?.connectionUrl ?? null,
      cwd: props.gitCwd,
      queryClient,
    }),
  );

  const handleGitInit = () => {
    const threadToastData = props.activeThreadId ? { threadId: props.activeThreadId } : undefined;
    const promise = initMutation.mutateAsync();
    toastManager.promise(promise, {
      loading: { title: "Initializing Git repository...", data: threadToastData },
      success: () => ({
        title: "Git initialized",
        description: "Git repository was successfully initialized in this workspace.",
        data: threadToastData,
      }),
      error: (err) => ({
        title: "Failed to initialize Git",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      }),
    });
  };
  const [groupOpenState, setGroupOpenState] = useLocalStorage<
    EnvironmentPanelGroupOpenState,
    EnvironmentPanelGroupOpenState
  >(
    resolveEnvironmentPanelGroupStorageKey(props.activeThreadId),
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
  const activeProjectScripts = props.activeProjectScripts;
  const subagentThreads = props.subagentThreads;
  const workspaceChangeStat = props.workspaceChangeStat;
  const hasChanges =
    workspaceChangeStat !== null &&
    (workspaceChangeStat.additions > 0 || workspaceChangeStat.deletions > 0);
  const isCheckingChanges =
    props.isGitRepo && props.gitStatus === null && props.gitStatusError === null;
  const activeSubagentThreads = subagentThreads.filter((thread) => thread.status === "running");
  const activeTodoSteps = activePlan?.steps ?? [];

  return (
    <m.aside
      ref={ref}
      className={cn(
        ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
        "pointer-events-auto z-50 w-[min(21rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] overflow-y-auto p-2 sm:p-2.5",
        "[overflow-anchor:none]",
        props.layoutMode === "inline"
          ? "absolute top-3 right-3 max-h-[calc(100%_-_1.5rem)]"
          : "fixed max-h-[min(42rem,calc(100vh-1rem))]",
      )}
      initial={{ opacity: 0, scale: 0.985, x: 22 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.985, x: 18 }}
      data-slot="environment-mini-panel"
      transition={PANEL_SPRING_TRANSITION}
      {...(props.style ? { style: props.style } : {})}
    >
      <div className="space-y-0">
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
                  className={cn(
                    ENVIRONMENT_PANEL_ROW_CLASS_NAME,
                    "min-h-7 py-0.5 leading-snug text-muted-foreground",
                  )}
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
                    className="-mr-1 size-7 shrink-0 rounded-[var(--control-radius)] bg-transparent text-muted-foreground/78 transition-colors hover:bg-black/[0.045] hover:text-foreground dark:hover:bg-white/[0.09]"
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
            className={ENVIRONMENT_PANEL_ROW_CLASS_NAME}
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
            <button
              type="button"
              className={ENVIRONMENT_PANEL_ROW_CLASS_NAME}
              disabled={initMutation.isPending}
              onClick={handleGitInit}
            >
              {initMutation.isPending ? (
                <Spinner className="size-3.5" />
              ) : (
                <GitBranchPlusIcon className="size-3.5 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                {initMutation.isPending ? "Initializing Git..." : "Initialize Git"}
              </span>
            </button>
          ) : null}
        </EnvironmentPanelGroup>

        <EnvironmentPinnedMessagesGroup
          messages={threadPinnedMessages}
          onJumpToMessage={props.onJumpToMessage}
          open={resolveEnvironmentPanelGroupOpen(groupOpenState, "pinnedMessages")}
          onOpenChange={(open) => setGroupOpen("pinnedMessages", open)}
          setPinnedMessages={setPinnedMessages}
        />

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

        {activeSubagentThreads.length > 0 ? (
          <EnvironmentPanelGroup
            title="Subagents"
            open={resolveEnvironmentPanelGroupOpen(groupOpenState, "subagents")}
            onOpenChange={(open) => setGroupOpen("subagents", open)}
          >
            <div className="space-y-1">
              {activeSubagentThreads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className={cn(ENVIRONMENT_PANEL_ROW_CLASS_NAME, "gap-1.5")}
                  onClick={() => {
                    props.onSelectSubagentThread(thread.id);
                    props.onSubagentPanelOpen();
                  }}
                >
                  <EnvironmentSubagentIcon thread={thread} />
                  <span className="min-w-0 flex-1 truncate font-medium">{thread.label}</span>
                </button>
              ))}
            </div>
          </EnvironmentPanelGroup>
        ) : null}

        <EnvironmentNotesGroup
          body={activeScratchPadNote?.body ?? ""}
          open={resolveEnvironmentPanelGroupOpen(groupOpenState, "notes")}
          onBodyChange={updateActiveScratchPadBody}
          onOpenChange={(open) => setGroupOpen("notes", open)}
        />
      </div>
    </m.aside>
  );
}
