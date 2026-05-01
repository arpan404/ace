import type {
  GitHubIssue,
  ModelSelection,
  ProjectEntry,
  ProviderKind,
  ProviderInteractionMode,
  ProviderModelOptions,
  RuntimeMode,
  ServerProvider,
  ServerProviderModel,
  ThreadHandoffMode,
  ThreadId,
} from "@ace/contracts";
import type { UnifiedSettings } from "@ace/contracts/settings";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ace/contracts";
import {
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type FormEvent,
  type ReactNode,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";

import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  extendReplacementRangeForTrailingSpace,
  replaceTextRange,
} from "../../composer-logic";
import { createMarkedIssueReferenceToken } from "../../composer-editor-mentions";
import {
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import { isLayoutResizeInProgress, SIDEBAR_RESIZE_END_EVENT } from "../../lib/desktopChrome";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  resolveComposerFooterContentWidth,
  shouldForceCompactComposerFooterForFit,
  shouldUseCompactComposerFooter,
  shouldUseCompactComposerPrimaryActions,
} from "../../lib/composer/footerLayout";
import { useEffectEvent } from "../../hooks/useEffectEvent";
import { gitGitHubIssuesQueryOptions } from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { basenameOfPath } from "../../vscode-icons";
import { randomUUID } from "~/lib/utils";
import { syncTerminalContextsByIds, terminalContextIdListsEqual } from "../../lib/terminalContext";
import { resolveAppModelSelection } from "../../modelSelection";
import { getComposerProviderState } from "./composerProviderRegistry";
import { AVAILABLE_PROVIDER_OPTIONS } from "./ProviderModelPicker";
import { resolveSelectableProvider } from "../../providerModels";
import { ChatComposerPanel } from "./ChatComposerPanel";
import { ProviderStatusBanner } from "./ProviderStatusBanner";
import { deriveComposerSendState, readFileAsDataUrl } from "~/lib/chat/chatView";
import { toastManager } from "../ui/toast";
import { useChatViewProviderSelectionState } from "./useChatViewModelState";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";

const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_GITHUB_ISSUES: readonly GitHubIssue[] = [];
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const EMPTY_MODEL_SELECTIONS: Partial<Record<ProviderKind, ModelSelection>> = Object.freeze({});

export interface ConnectedChatComposerPanelsHandle {
  focusAt(cursor: number): boolean;
  focusAtEnd(): boolean;
  readSnapshot(): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } | null;
  resetUi(prompt?: string): void;
}

interface ConnectedComposerProviderStatusBannerProps {
  readonly threadId: ThreadId;
  readonly hasThreadStarted: boolean;
  readonly isServerThread: boolean;
  readonly modelSettings: Pick<UnifiedSettings, "providers">;
  readonly projectModelSelection: ModelSelection | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sessionProvider: ProviderKind | null;
  readonly threadModelSelection: ModelSelection | null | undefined;
}

export const ConnectedComposerProviderStatusBanner = memo(
  function ConnectedComposerProviderStatusBanner(
    props: ConnectedComposerProviderStatusBannerProps,
  ) {
    const draftSelection = useComposerDraftStore(
      useShallow((state) => {
        const draft = state.draftsByThreadId[props.threadId];
        return {
          activeProvider: draft?.activeProvider ?? null,
          modelSelectionByProvider: draft?.modelSelectionByProvider ?? EMPTY_MODEL_SELECTIONS,
        };
      }),
    );
    const { activeProviderStatus } = useChatViewProviderSelectionState({
      draft: draftSelection,
      hasThreadStarted: props.hasThreadStarted,
      isServerThread: props.isServerThread,
      modelSettings: props.modelSettings,
      projectModelSelection: props.projectModelSelection,
      providers: props.providers,
      sessionProvider: props.sessionProvider,
      threadModelSelection: props.threadModelSelection,
    });

    return <ProviderStatusBanner status={activeProviderStatus} />;
  },
);

interface ConnectedChatComposerPanelsProps {
  readonly threadId: ThreadId;
  readonly activeForSideEffects: boolean;
  readonly gitCwd: string | null;
  readonly isGitRepo: boolean;
  readonly modelSettings: Pick<UnifiedSettings, "providers">;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly isServerThread: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly composerModelOptions: ProviderModelOptions | null;
  readonly selectedProvider: ProviderKind;
  readonly selectedModel: string;
  readonly selectedProviderModels: ReadonlyArray<ServerProviderModel>;
  readonly selectedProviderModelOptions: ProviderModelOptions[ProviderKind] | undefined;
  readonly selectedModelForPickerWithCustomFallback: string;
  readonly lockedProvider: ProviderKind | null;
  readonly modelOptionsByProvider: ComponentProps<
    typeof ChatComposerPanel
  >["modelOptionsByProvider"];
  readonly handoffTargetProviders: ReadonlyArray<ProviderKind>;
  readonly handoffDisabled: boolean;
  readonly interactionModeShortcutLabel: string | null;
  readonly activeContextWindow: ComponentProps<typeof ChatComposerPanel>["activeContextWindow"];
  readonly queuedComposerMessages: ComponentProps<
    typeof ChatComposerPanel
  >["queuedComposerMessages"];
  readonly queuedSteerMessageId: ComponentProps<typeof ChatComposerPanel>["queuedSteerMessageId"];
  readonly liveTurnInProgress: boolean;
  readonly isConnecting: boolean;
  readonly isPreparingWorktree: boolean;
  readonly isSendBusy: boolean;
  readonly allowQueueWhenSendable: boolean;
  readonly activePendingApproval: ComponentProps<typeof ChatComposerPanel>["activePendingApproval"];
  readonly pendingApprovalsCount: number;
  readonly pendingUserInputs: ComponentProps<typeof ChatComposerPanel>["pendingUserInputs"];
  readonly respondingApprovalRequestIds: ReadonlyArray<string>;
  readonly respondingUserInputRequestIds: ComponentProps<
    typeof ChatComposerPanel
  >["respondingUserInputRequestIds"];
  readonly activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingQuestionIndex: number;
  readonly activePendingProgress: ComponentProps<typeof ChatComposerPanel>["activePendingProgress"];
  readonly activePendingIsResponding: boolean;
  readonly activePendingResolvedAnswers: unknown;
  readonly planFollowUpId: string | null;
  readonly planFollowUpTitle: string | null;
  readonly resolvedTheme: ComponentProps<typeof ChatComposerPanel>["resolvedTheme"];
  readonly showFloatingDock: boolean;
  readonly floatingDockFooter?: ReactNode;
  readonly onComposerHeightChange: () => void;
  readonly onPreviewExpandedImage: (preview: ExpandedImagePreview) => void;
  readonly onIssuePreviewOpen: (issueNumber: number) => void;
  readonly onPendingUserInputCustomAnswerChange: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;
  readonly onSubmit: ComponentProps<typeof ChatComposerPanel>["onSubmit"];
  readonly onRespondToApproval: ComponentProps<typeof ChatComposerPanel>["onRespondToApproval"];
  readonly onSelectPendingUserInputOption: ComponentProps<
    typeof ChatComposerPanel
  >["onSelectPendingUserInputOption"];
  readonly onAdvancePendingUserInput: ComponentProps<
    typeof ChatComposerPanel
  >["onAdvancePendingUserInput"];
  readonly onHandoffToProvider: (provider: ProviderKind, mode: ThreadHandoffMode) => void;
  readonly onToggleInteractionMode: () => void;
  readonly onRuntimeModeChange: (
    mode: ComponentProps<typeof ChatComposerPanel>["runtimeMode"],
  ) => void;
  readonly onPreviousPendingQuestion: () => void;
  readonly onInterrupt: () => void;
  readonly onImplementPlanInNewThread: () => void;
  readonly onQueueMessage: () => void;
  readonly onEditQueuedComposerMessage: ComponentProps<
    typeof ChatComposerPanel
  >["onEditQueuedComposerMessage"];
  readonly onDeleteQueuedComposerMessage: ComponentProps<
    typeof ChatComposerPanel
  >["onDeleteQueuedComposerMessage"];
  readonly onClearQueuedComposerMessages: ComponentProps<
    typeof ChatComposerPanel
  >["onClearQueuedComposerMessages"];
  readonly onReorderQueuedComposerMessages: ComponentProps<
    typeof ChatComposerPanel
  >["onReorderQueuedComposerMessages"];
  readonly onSteerQueuedComposerMessage: ComponentProps<
    typeof ChatComposerPanel
  >["onSteerQueuedComposerMessage"];
  readonly onSetThreadError: (threadId: ThreadId, error: string | null) => void;
}

export const ConnectedChatComposerPanels = memo(
  forwardRef<ConnectedChatComposerPanelsHandle, ConnectedChatComposerPanelsProps>(
    function ConnectedChatComposerPanels(props, ref) {
      const composerDraft = useComposerThreadDraft(props.threadId);
      const prompt = composerDraft.prompt;
      const composerImages = composerDraft.images;
      const composerTerminalContexts = composerDraft.terminalContexts;
      const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
      const composerSendState = useMemo(
        () =>
          deriveComposerSendState({
            prompt,
            imageCount: composerImages.length,
            terminalContexts: composerTerminalContexts,
          }),
        [composerImages.length, composerTerminalContexts, prompt],
      );
      const composerProviderState = useMemo(
        () =>
          getComposerProviderState({
            provider: props.selectedProvider,
            model: props.selectedModel,
            models: props.selectedProviderModels,
            prompt,
            modelOptions: props.composerModelOptions,
          }),
        [
          props.composerModelOptions,
          prompt,
          props.selectedModel,
          props.selectedProvider,
          props.selectedProviderModels,
        ],
      );
      const [isDragOverComposer, setIsDragOverComposer] = useState(false);
      const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(
        null,
      );
      const [composerCursor, setComposerCursor] = useState(() =>
        collapseExpandedComposerCursor(prompt, prompt.length),
      );
      const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
        detectComposerTrigger(prompt, prompt.length),
      );
      const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
      const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
      const dragDepthRef = useRef(0);
      const promptRef = useRef(prompt);
      const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
      const floatingComposerEditorRef = useRef<ComposerPromptEditorHandle>(null);
      const composerFormRef = useRef<HTMLFormElement>(null);
      const floatingComposerFormRef = useRef<HTMLFormElement>(null);
      const composerFooterRef = useRef<HTMLDivElement>(null);
      const floatingComposerFooterRef = useRef<HTMLDivElement>(null);
      const composerFooterLeadingRef = useRef<HTMLDivElement>(null);
      const floatingComposerFooterLeadingRef = useRef<HTMLDivElement>(null);
      const composerFooterActionsRef = useRef<HTMLDivElement>(null);
      const floatingComposerFooterActionsRef = useRef<HTMLDivElement>(null);
      const composerFormHeightRef = useRef(0);
      const composerSelectLockRef = useRef(false);
      const composerMenuOpenRef = useRef(false);
      const dismissedComposerTriggerRef = useRef<{
        kind: ComposerTrigger["kind"];
        rangeStart: number;
      } | null>(null);
      const composerMenuItemsRef = useRef<
        ComponentProps<typeof ChatComposerPanel>["composerMenuItems"]
      >([]);
      const activeComposerMenuItemRef = useRef<
        ComponentProps<typeof ChatComposerPanel>["composerMenuItems"][number] | null
      >(null);
      const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
      const setComposerDraftModelSelection = useComposerDraftStore(
        (store) => store.setModelSelection,
      );
      const setComposerDraftProviderModelOptions = useComposerDraftStore(
        (store) => store.setProviderModelOptions,
      );
      const setComposerDraftTerminalContexts = useComposerDraftStore(
        (store) => store.setTerminalContexts,
      );
      const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
      const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
      const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
      const removeComposerDraftTerminalContext = useComposerDraftStore(
        (store) => store.removeTerminalContext,
      );
      const clearComposerDraftPersistedAttachments = useComposerDraftStore(
        (store) => store.clearPersistedAttachments,
      );
      const syncComposerDraftPersistedAttachments = useComposerDraftStore(
        (store) => store.syncPersistedAttachments,
      );
      const setStickyComposerModelSelection = useComposerDraftStore(
        (store) => store.setStickyModelSelection,
      );
      const nonPersistedComposerImageIdSet = useMemo(
        () => new Set(nonPersistedComposerImageIds),
        [nonPersistedComposerImageIds],
      );
      const showPlanFollowUpPrompt =
        props.pendingUserInputs.length === 0 &&
        props.interactionMode === "plan" &&
        props.planFollowUpId !== null;
      const activePendingUserInput = props.pendingUserInputs[0] ?? null;
      const activePendingQuestion =
        activePendingUserInput?.questions[props.activePendingQuestionIndex] ?? null;
      const {
        onComposerHeightChange,
        onPendingUserInputCustomAnswerChange,
        onPreviewExpandedImage,
      } = props;
      const isComposerApprovalState = props.activePendingApproval !== null;
      const hasComposerHeader =
        isComposerApprovalState || (showPlanFollowUpPrompt && props.planFollowUpId !== null);
      const composerFooterHasWideActions =
        showPlanFollowUpPrompt || props.activePendingProgress !== null;
      const composerFooterActionLayoutKey = useMemo(() => {
        if (props.activePendingProgress) {
          return `pending:${props.activePendingProgress.questionIndex}:${props.activePendingProgress.isLastQuestion}:${props.activePendingIsResponding}`;
        }
        if (showPlanFollowUpPrompt) {
          return `plan-follow-up:${props.planFollowUpId ?? "none"}`;
        }
        return `idle:${composerSendState.hasSendableContent}:${props.isSendBusy}:${props.isConnecting}:${props.isPreparingWorktree}`;
      }, [
        composerSendState.hasSendableContent,
        props.activePendingIsResponding,
        props.activePendingProgress,
        props.isConnecting,
        props.isPreparingWorktree,
        props.isSendBusy,
        props.planFollowUpId,
        showPlanFollowUpPrompt,
      ]);

      const focusComposer = useCallback(() => {
        return composerEditorRef.current?.focusAtEnd() ?? false;
      }, []);
      const scheduleComposerFocus = useCallback(
        (attempts = 4) => {
          let frameId: number | null = null;
          const requestFocus = (remainingAttempts: number) => {
            frameId = window.requestAnimationFrame(() => {
              frameId = null;
              if (focusComposer() || remainingAttempts <= 1) {
                return;
              }
              requestFocus(remainingAttempts - 1);
            });
          };

          requestFocus(Math.max(1, attempts));
          return () => {
            if (frameId !== null) {
              window.cancelAnimationFrame(frameId);
            }
          };
        },
        [focusComposer],
      );

      const detectComposerTriggerWithDismissal = useCallback(
        (text: string, expandedCursor: number): ComposerTrigger | null => {
          const detected = detectComposerTrigger(text, expandedCursor);
          if (!detected) {
            dismissedComposerTriggerRef.current = null;
            return null;
          }
          const dismissed = dismissedComposerTriggerRef.current;
          if (
            dismissed &&
            dismissed.kind === detected.kind &&
            dismissed.rangeStart === detected.rangeStart
          ) {
            return null;
          }
          dismissedComposerTriggerRef.current = null;
          return detected;
        },
        [],
      );

      const resetUi = useCallback(
        (nextPrompt = promptRef.current) => {
          const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
          setComposerHighlightedItemId(null);
          setComposerCursor(nextCursor);
          setComposerTrigger(detectComposerTriggerWithDismissal(nextPrompt, nextPrompt.length));
        },
        [detectComposerTriggerWithDismissal],
      );

      useImperativeHandle(
        ref,
        () => ({
          focusAt(cursor: number) {
            return composerEditorRef.current?.focusAt(cursor) ?? false;
          },
          focusAtEnd() {
            return composerEditorRef.current?.focusAtEnd() ?? false;
          },
          readSnapshot() {
            return composerEditorRef.current?.readSnapshot() ?? null;
          },
          resetUi,
        }),
        [resetUi],
      );

      const composerTriggerKind = composerTrigger?.kind ?? null;
      const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
      const issueTriggerQuery = composerTrigger?.kind === "issue" ? composerTrigger.query : "";
      const isPathTrigger = composerTriggerKind === "path";
      const isIssueTrigger = composerTriggerKind === "issue";
      const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
        pathTriggerQuery,
        {
          wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS,
        },
        (debouncerState) => ({ isPending: debouncerState.isPending }),
      );
      const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
      const searchableModelOptions = useMemo(
        () =>
          AVAILABLE_PROVIDER_OPTIONS.filter(
            (option) => props.lockedProvider === null || option.value === props.lockedProvider,
          ).flatMap((option) =>
            props.modelOptionsByProvider[option.value].map(({ slug, name }) => ({
              provider: option.value,
              providerLabel: option.label,
              slug,
              name,
              searchSlug: slug.toLowerCase(),
              searchName: name.toLowerCase(),
              searchProvider: option.label.toLowerCase(),
            })),
          ),
        [props.lockedProvider, props.modelOptionsByProvider],
      );
      const workspaceEntriesQuery = useQuery(
        projectSearchEntriesQueryOptions({
          cwd: props.gitCwd,
          query: effectivePathQuery,
          enabled: isPathTrigger && props.activeForSideEffects,
          limit: 80,
        }),
      );
      const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
      const issueTriggerLookupQuery = useQuery(
        gitGitHubIssuesQueryOptions({
          cwd: props.gitCwd,
          limit: 120,
          state: "all",
          enabled: isIssueTrigger && props.isGitRepo && props.activeForSideEffects,
        }),
      );
      const issueTriggerMatches = useMemo(() => {
        const issues = issueTriggerLookupQuery.data?.issues ?? EMPTY_GITHUB_ISSUES;
        if (issueTriggerQuery.length === 0) {
          return issues;
        }
        return issues.filter((issue) => String(issue.number).startsWith(issueTriggerQuery));
      }, [issueTriggerLookupQuery.data?.issues, issueTriggerQuery]);
      const composerMenuItems = useMemo<
        ComponentProps<typeof ChatComposerPanel>["composerMenuItems"]
      >(() => {
        if (!composerTrigger) return [];
        if (composerTrigger.kind === "path") {
          return workspaceEntries.map((entry) => ({
            id: `path:${entry.kind}:${entry.path}`,
            type: "path",
            path: entry.path,
            pathKind: entry.kind,
            label: basenameOfPath(entry.path),
            description: entry.parentPath ?? "",
          }));
        }
        if (composerTrigger.kind === "issue") {
          return issueTriggerMatches.map((issue) => ({
            id: `issue:${issue.number}`,
            type: "issue",
            issueNumber: issue.number,
            label: `#${issue.number} ${issue.title}`,
            description: issue.state === "open" ? "Open issue" : "Closed issue",
          }));
        }
        if (composerTrigger.kind === "slash-command") {
          const slashCommandItems = [
            {
              id: "slash:model",
              type: "slash-command" as const,
              command: "model" as const,
              label: "/model",
              description: "Switch response model for this thread",
            },
            {
              id: "slash:plan",
              type: "slash-command" as const,
              command: "plan" as const,
              label: "/plan",
              description: "Switch this thread into plan mode",
            },
            {
              id: "slash:default",
              type: "slash-command" as const,
              command: "default" as const,
              label: "/default",
              description: "Switch this thread back to normal chat mode",
            },
            {
              id: "slash:issues",
              type: "slash-command" as const,
              command: "issues" as const,
              label: "/issues",
              description: "Attach GitHub issue context to this message",
            },
          ];
          const query = composerTrigger.query.trim().toLowerCase();
          if (!query) {
            return [...slashCommandItems];
          }
          return slashCommandItems.filter(
            (item) => item.command.includes(query) || item.label.slice(1).includes(query),
          );
        }
        return searchableModelOptions
          .filter(({ searchSlug, searchName, searchProvider }) => {
            const query = composerTrigger.query.trim().toLowerCase();
            if (!query) return true;
            return (
              searchSlug.includes(query) ||
              searchName.includes(query) ||
              searchProvider.includes(query)
            );
          })
          .map(({ provider, providerLabel, slug, name }) => ({
            id: `model:${provider}:${slug}`,
            type: "model" as const,
            provider,
            model: slug,
            label: name,
            description: `${providerLabel} · ${slug}`,
          }));
      }, [composerTrigger, issueTriggerMatches, searchableModelOptions, workspaceEntries]);
      const composerMenuOpen = Boolean(composerTrigger);
      const activeComposerMenuItem = useMemo(
        () =>
          composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
          composerMenuItems[0] ??
          null,
        [composerHighlightedItemId, composerMenuItems],
      );
      composerMenuOpenRef.current = composerMenuOpen;
      composerMenuItemsRef.current = composerMenuItems;
      activeComposerMenuItemRef.current = activeComposerMenuItem;
      const isComposerMenuLoading =
        (composerTriggerKind === "path" &&
          ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
            workspaceEntriesQuery.isLoading ||
            workspaceEntriesQuery.isFetching)) ||
        (composerTriggerKind === "issue" &&
          (issueTriggerLookupQuery.isLoading || issueTriggerLookupQuery.isFetching));
      const showIssuesCommandExamplesHint =
        !isComposerApprovalState &&
        props.pendingUserInputs.length === 0 &&
        /^\/issues\s*$/i.test(prompt.trimStart());
      const showIssuesCommandExamplesPopover = showIssuesCommandExamplesHint && !composerMenuOpen;

      const setPrompt = useCallback(
        (nextPrompt: string) => {
          setComposerDraftPrompt(props.threadId, nextPrompt);
        },
        [props.threadId, setComposerDraftPrompt],
      );

      const addComposerImages = useEffectEvent((files: File[]) => {
        if (files.length === 0) return;
        if (props.pendingUserInputs.length > 0) {
          toastManager.add({
            type: "error",
            title: "Attach images after answering plan questions.",
          });
          return;
        }

        const nextImages: ComposerImageAttachment[] = [];
        let nextImageCount = composerImages.length;
        let error: string | null = null;
        for (const file of files) {
          if (!file.type.startsWith("image/")) {
            error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
            continue;
          }
          if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
            continue;
          }
          if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
            error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
            break;
          }
          nextImages.push({
            type: "image",
            id: randomUUID(),
            name: file.name || "image",
            mimeType: file.type,
            sizeBytes: file.size,
            previewUrl: URL.createObjectURL(file),
            file,
          });
          nextImageCount += 1;
        }

        if (nextImages.length === 1 && nextImages[0]) {
          addComposerDraftImage(props.threadId, nextImages[0]);
        } else if (nextImages.length > 1) {
          addComposerDraftImages(props.threadId, nextImages);
        }
        props.onSetThreadError(props.threadId, error);
      });

      const onComposerPaste = useCallback((event: ClipboardEvent<HTMLElement>) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) {
          return;
        }
        const imageFiles = files.filter((file) => file.type.startsWith("image/"));
        if (imageFiles.length === 0) {
          return;
        }
        event.preventDefault();
        addComposerImages(imageFiles);
      }, []);

      const onComposerDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes("Files")) {
          return;
        }
        event.preventDefault();
        dragDepthRef.current += 1;
        setIsDragOverComposer(true);
      }, []);

      const onComposerDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes("Files")) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setIsDragOverComposer(true);
      }, []);

      const onComposerDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes("Files")) {
          return;
        }
        event.preventDefault();
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return;
        }
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
          setIsDragOverComposer(false);
        }
      }, []);

      const onComposerDrop = useCallback(
        (event: DragEvent<HTMLDivElement>) => {
          if (!event.dataTransfer.types.includes("Files")) {
            return;
          }
          event.preventDefault();
          dragDepthRef.current = 0;
          setIsDragOverComposer(false);
          addComposerImages(Array.from(event.dataTransfer.files));
          scheduleComposerFocus();
        },
        [scheduleComposerFocus],
      );

      const removeComposerImage = useCallback(
        (imageId: string) => {
          removeComposerDraftImage(props.threadId, imageId);
        },
        [props.threadId, removeComposerDraftImage],
      );

      const onPreviewComposerImage = useCallback(
        (imageId: string) => {
          const preview = buildExpandedImagePreview(composerImages, imageId);
          if (!preview) {
            return;
          }
          onPreviewExpandedImage(preview);
        },
        [composerImages, onPreviewExpandedImage],
      );

      const setPromptFromTraits = useCallback(
        (nextPrompt: string) => {
          const currentPrompt = promptRef.current;
          if (nextPrompt === currentPrompt) {
            scheduleComposerFocus();
            return;
          }
          promptRef.current = nextPrompt;
          setPrompt(nextPrompt);
          resetUi(nextPrompt);
          scheduleComposerFocus();
        },
        [resetUi, scheduleComposerFocus, setPrompt],
      );

      const onProviderModelSelect = useEffectEvent((provider: ProviderKind, model: string) => {
        if (props.lockedProvider !== null && provider !== props.lockedProvider) {
          scheduleComposerFocus();
          return;
        }
        const resolvedProvider = resolveSelectableProvider(props.providers, provider);
        const resolvedModel = resolveAppModelSelection(
          resolvedProvider,
          props.modelSettings,
          props.providers,
          model,
        );
        const nextModelSelection: ModelSelection = {
          provider: resolvedProvider,
          model: resolvedModel,
        };
        if (resolvedProvider === "cursor") {
          setComposerDraftProviderModelOptions(props.threadId, "cursor", undefined, {
            persistSticky: true,
          });
        }
        setComposerDraftModelSelection(props.threadId, nextModelSelection);
        setStickyComposerModelSelection(nextModelSelection);
        scheduleComposerFocus();
      });

      const applyPromptReplacement = useCallback(
        (
          rangeStart: number,
          rangeEnd: number,
          replacement: string,
          options?: { expectedText?: string },
        ): boolean => {
          const currentText = promptRef.current;
          const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
          const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
          if (
            options?.expectedText !== undefined &&
            currentText.slice(safeStart, safeEnd) !== options.expectedText
          ) {
            return false;
          }
          const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
          const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
          promptRef.current = next.text;
          if (activePendingQuestion && activePendingUserInput) {
            onPendingUserInputCustomAnswerChange(
              activePendingQuestion.id,
              next.text,
              nextCursor,
              next.cursor,
              false,
            );
          } else {
            setPrompt(next.text);
          }
          setComposerCursor(nextCursor);
          setComposerTrigger(
            detectComposerTriggerWithDismissal(
              next.text,
              expandCollapsedComposerCursor(next.text, nextCursor),
            ),
          );
          window.requestAnimationFrame(() => {
            composerEditorRef.current?.focusAt(nextCursor);
          });
          return true;
        },
        [
          detectComposerTriggerWithDismissal,
          activePendingUserInput,
          activePendingQuestion,
          onPendingUserInputCustomAnswerChange,
          setPrompt,
        ],
      );

      const readComposerSnapshot = useCallback(() => {
        const editorSnapshot = composerEditorRef.current?.readSnapshot();
        if (editorSnapshot) {
          return editorSnapshot;
        }
        return {
          value: promptRef.current,
          cursor: composerCursor,
          expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
          terminalContextIds: composerTerminalContexts.map((context) => context.id),
        };
      }, [composerCursor, composerTerminalContexts]);

      const resolveActiveComposerTrigger = useCallback(() => {
        const snapshot = readComposerSnapshot();
        return {
          snapshot,
          trigger: detectComposerTriggerWithDismissal(snapshot.value, snapshot.expandedCursor),
        };
      }, [detectComposerTriggerWithDismissal, readComposerSnapshot]);

      const onSelectComposerItem = useEffectEvent(
        (item: ComponentProps<typeof ChatComposerPanel>["composerMenuItems"][number]) => {
          if (composerSelectLockRef.current) return;
          composerSelectLockRef.current = true;
          window.requestAnimationFrame(() => {
            composerSelectLockRef.current = false;
          });
          const { snapshot, trigger } = resolveActiveComposerTrigger();
          if (!trigger) return;
          if (item.type === "path") {
            const replacement = `@${item.path} `;
            const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
              snapshot.value,
              trigger.rangeEnd,
              replacement,
            );
            if (
              applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
                expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
              })
            ) {
              setComposerHighlightedItemId(null);
            }
            return;
          }
          if (item.type === "issue") {
            const replacement = `${createMarkedIssueReferenceToken(item.issueNumber)} `;
            const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
              snapshot.value,
              trigger.rangeEnd,
              replacement,
            );
            if (
              applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
                expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
              })
            ) {
              setComposerHighlightedItemId(null);
            }
            return;
          }
          if (item.type === "slash-command") {
            if (item.command === "model" || item.command === "issues") {
              const replacement = item.command === "model" ? "/model " : "/issues ";
              const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
                snapshot.value,
                trigger.rangeEnd,
                replacement,
              );
              if (
                applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
                  expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
                })
              ) {
                setComposerHighlightedItemId(null);
              }
              return;
            }
            props.onToggleInteractionMode();
            if (
              applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
                expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
              })
            ) {
              setComposerHighlightedItemId(null);
            }
            return;
          }
          onProviderModelSelect(item.provider, item.model);
          if (
            applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
              expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            })
          ) {
            setComposerHighlightedItemId(null);
          }
        },
      );

      const nudgeComposerMenuHighlight = useCallback(
        (key: "ArrowDown" | "ArrowUp") => {
          if (composerMenuItems.length === 0) {
            return;
          }
          const highlightedIndex = composerMenuItems.findIndex(
            (item) => item.id === composerHighlightedItemId,
          );
          const normalizedIndex =
            highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
          const offset = key === "ArrowDown" ? 1 : -1;
          const nextIndex =
            (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
          const nextItem = composerMenuItems[nextIndex];
          setComposerHighlightedItemId(nextItem?.id ?? null);
        },
        [composerHighlightedItemId, composerMenuItems],
      );

      const onComposerCommandKey = useEffectEvent(
        (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape", event: KeyboardEvent) => {
          if (key === "Tab" && event.shiftKey) {
            props.onToggleInteractionMode();
            return true;
          }
          const { trigger } = resolveActiveComposerTrigger();
          const menuIsActive = composerMenuOpenRef.current || trigger !== null;
          if (key === "Escape" && menuIsActive) {
            const dismissedTrigger = trigger ?? composerTrigger;
            if (dismissedTrigger) {
              dismissedComposerTriggerRef.current = {
                kind: dismissedTrigger.kind,
                rangeStart: dismissedTrigger.rangeStart,
              };
            }
            setComposerTrigger(null);
            setComposerHighlightedItemId(null);
            return true;
          }
          if (menuIsActive) {
            const currentItems = composerMenuItemsRef.current;
            if (key === "ArrowDown" && currentItems.length > 0) {
              nudgeComposerMenuHighlight("ArrowDown");
              return true;
            }
            if (key === "ArrowUp" && currentItems.length > 0) {
              nudgeComposerMenuHighlight("ArrowUp");
              return true;
            }
            if (key === "Tab" || key === "Enter") {
              const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
              if (selectedItem) {
                onSelectComposerItem(selectedItem);
                return true;
              }
            }
          }
          if (key === "Enter" && !event.shiftKey) {
            void props.onSubmit(event as unknown as FormEvent<HTMLFormElement>);
            return true;
          }
          return false;
        },
      );

      const onPromptChange = useCallback(
        (
          nextPrompt: string,
          nextCursor: number,
          expandedCursor: number,
          cursorAdjacentToMention: boolean,
          terminalContextIds: string[],
        ) => {
          if (activePendingQuestion && activePendingUserInput) {
            onPendingUserInputCustomAnswerChange(
              activePendingQuestion.id,
              nextPrompt,
              nextCursor,
              expandedCursor,
              cursorAdjacentToMention,
            );
            return;
          }
          promptRef.current = nextPrompt;
          setPrompt(nextPrompt);
          if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
            setComposerDraftTerminalContexts(
              props.threadId,
              syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
            );
          }
          setComposerCursor(nextCursor);
          setComposerTrigger(
            cursorAdjacentToMention
              ? null
              : detectComposerTriggerWithDismissal(nextPrompt, expandedCursor),
          );
        },
        [
          composerTerminalContexts,
          detectComposerTriggerWithDismissal,
          activePendingUserInput,
          activePendingQuestion,
          onPendingUserInputCustomAnswerChange,
          props.threadId,
          setComposerDraftTerminalContexts,
          setPrompt,
        ],
      );

      useEffect(() => {
        promptRef.current = prompt;
        setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
      }, [prompt]);

      useEffect(() => {
        const nextCustomAnswer = props.activePendingProgress?.customAnswer;
        if (nextCustomAnswer === undefined) {
          return;
        }
        const textChangedExternally = promptRef.current !== nextCustomAnswer;
        if (!textChangedExternally) {
          return;
        }
        promptRef.current = nextCustomAnswer;
        resetUi(nextCustomAnswer);
      }, [activePendingQuestion?.id, props.activePendingProgress?.customAnswer, resetUi]);

      useEffect(() => {
        setComposerHighlightedItemId((existing) =>
          composerMenuOpen && composerMenuItems.some((item) => item.id === existing)
            ? existing
            : composerMenuOpen
              ? (composerMenuItems[0]?.id ?? null)
              : null,
        );
      }, [composerMenuItems, composerMenuOpen]);

      useEffect(() => {
        dragDepthRef.current = 0;
        setIsDragOverComposer(false);
        resetUi(promptRef.current);
      }, [props.threadId, resetUi]);

      useEffect(() => {
        let cancelled = false;
        void (async () => {
          if (composerImages.length === 0) {
            clearComposerDraftPersistedAttachments(props.threadId);
            return;
          }
          const getPersistedAttachmentsForThread = () =>
            useComposerDraftStore.getState().draftsByThreadId[props.threadId]
              ?.persistedAttachments ?? [];
          try {
            const currentPersistedAttachments = getPersistedAttachmentsForThread();
            const existingPersistedById = new Map(
              currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
            );
            const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
            await Promise.all(
              composerImages.map(async (image) => {
                try {
                  const dataUrl = await readFileAsDataUrl(image.file);
                  stagedAttachmentById.set(image.id, {
                    id: image.id,
                    name: image.name,
                    mimeType: image.mimeType,
                    sizeBytes: image.sizeBytes,
                    dataUrl,
                  });
                } catch {
                  const existingPersisted = existingPersistedById.get(image.id);
                  if (existingPersisted) {
                    stagedAttachmentById.set(image.id, existingPersisted);
                  }
                }
              }),
            );
            if (cancelled) {
              return;
            }
            syncComposerDraftPersistedAttachments(
              props.threadId,
              Array.from(stagedAttachmentById.values()),
            );
          } catch {
            const currentImageIds = new Set(composerImages.map((image) => image.id));
            const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
            const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
              currentImageIds.has(attachment.id),
            );
            if (cancelled) {
              return;
            }
            syncComposerDraftPersistedAttachments(props.threadId, fallbackAttachments);
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [
        clearComposerDraftPersistedAttachments,
        composerImages,
        props.threadId,
        syncComposerDraftPersistedAttachments,
      ]);

      useLayoutEffect(() => {
        if (!props.activeForSideEffects) return;
        const composerForm = composerFormRef.current;
        if (!composerForm) return;
        const measureComposerFormWidth = () => composerForm.clientWidth;
        const measureFooterCompactness = () => {
          const composerFormWidth = measureComposerFormWidth();
          const heuristicFooterCompact = shouldUseCompactComposerFooter(composerFormWidth, {
            hasWideActions: composerFooterHasWideActions,
          });
          const footer = composerFooterRef.current;
          const footerStyle = footer ? window.getComputedStyle(footer) : null;
          const footerContentWidth = resolveComposerFooterContentWidth({
            footerWidth: footer?.clientWidth ?? null,
            paddingLeft: footerStyle ? Number.parseFloat(footerStyle.paddingLeft) : null,
            paddingRight: footerStyle ? Number.parseFloat(footerStyle.paddingRight) : null,
          });
          const fitInput = {
            footerContentWidth,
            leadingContentWidth: composerFooterLeadingRef.current?.scrollWidth ?? null,
            actionsWidth: composerFooterActionsRef.current?.scrollWidth ?? null,
          };
          const nextFooterCompact =
            heuristicFooterCompact || shouldForceCompactComposerFooterForFit(fitInput);
          const nextPrimaryActionsCompact =
            nextFooterCompact &&
            shouldUseCompactComposerPrimaryActions(composerFormWidth, {
              hasWideActions: composerFooterHasWideActions,
            });
          return {
            footerCompact: nextFooterCompact,
            primaryActionsCompact: nextPrimaryActionsCompact,
          };
        };

        composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
        const initialCompactness = measureFooterCompactness();
        setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
        setIsComposerFooterCompact(initialCompactness.footerCompact);
        if (typeof ResizeObserver === "undefined") return;

        let pendingComposerHeight: number | null = null;
        let frameId: number | null = null;
        let pendingDeferredComposerMeasurement = false;
        const applyComposerMeasurement = () => {
          frameId = null;
          const nextCompactness = measureFooterCompactness();
          setIsComposerPrimaryActionsCompact((previous) =>
            previous === nextCompactness.primaryActionsCompact
              ? previous
              : nextCompactness.primaryActionsCompact,
          );
          setIsComposerFooterCompact((previous) =>
            previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
          );
          const nextHeight = pendingComposerHeight;
          pendingComposerHeight = null;
          if (nextHeight === null) return;
          const previousHeight = composerFormHeightRef.current;
          composerFormHeightRef.current = nextHeight;
          if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
          onComposerHeightChange();
        };
        const scheduleComposerMeasurement = (nextHeight: number) => {
          if (isLayoutResizeInProgress()) {
            pendingDeferredComposerMeasurement = true;
            pendingComposerHeight = nextHeight;
            return;
          }
          pendingComposerHeight = nextHeight;
          if (frameId !== null) {
            return;
          }
          frameId = window.requestAnimationFrame(applyComposerMeasurement);
        };
        const handleLayoutResizeEnd = () => {
          if (!pendingDeferredComposerMeasurement) {
            return;
          }
          pendingDeferredComposerMeasurement = false;
          scheduleComposerMeasurement(composerForm.getBoundingClientRect().height);
        };
        const observer = new ResizeObserver((entries) => {
          const [entry] = entries;
          if (!entry) return;
          scheduleComposerMeasurement(entry.contentRect.height);
        });
        observer.observe(composerForm);
        window.addEventListener("ace:native-window-resize-end", handleLayoutResizeEnd);
        window.addEventListener(SIDEBAR_RESIZE_END_EVENT, handleLayoutResizeEnd);
        return () => {
          observer.disconnect();
          window.removeEventListener("ace:native-window-resize-end", handleLayoutResizeEnd);
          window.removeEventListener(SIDEBAR_RESIZE_END_EVENT, handleLayoutResizeEnd);
          if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
          }
        };
      }, [
        composerFooterActionLayoutKey,
        composerFooterHasWideActions,
        props.activeForSideEffects,
        onComposerHeightChange,
      ]);

      return (
        <>
          <ChatComposerPanel
            threadId={props.threadId}
            isGitRepo={props.isGitRepo}
            isDragOverComposer={isDragOverComposer}
            hasComposerHeader={hasComposerHeader}
            isComposerApprovalState={isComposerApprovalState}
            isComposerFooterCompact={isComposerFooterCompact}
            isComposerPrimaryActionsCompact={isComposerPrimaryActionsCompact}
            isComposerMenuLoading={isComposerMenuLoading}
            composerMenuOpen={composerMenuOpen}
            showIssuesCommandExamplesPopover={showIssuesCommandExamplesPopover}
            isConnecting={props.isConnecting}
            isPreparingWorktree={props.isPreparingWorktree}
            liveTurnInProgress={props.liveTurnInProgress}
            isSendBusy={props.isSendBusy}
            showPlanFollowUpPrompt={showPlanFollowUpPrompt}
            prompt={prompt}
            composerCursor={composerCursor}
            composerTriggerKind={composerTriggerKind}
            composerMenuItems={composerMenuItems}
            activeComposerMenuItemId={activeComposerMenuItem?.id ?? null}
            composerImages={composerImages}
            nonPersistedComposerImageIdSet={nonPersistedComposerImageIdSet}
            composerTerminalContexts={composerTerminalContexts}
            queuedComposerMessages={props.queuedComposerMessages}
            queuedSteerMessageId={props.queuedSteerMessageId}
            composerProviderState={composerProviderState}
            selectedProvider={props.selectedProvider}
            selectedModel={props.selectedModel}
            selectedProviderModels={props.selectedProviderModels}
            selectedProviderModelOptions={props.selectedProviderModelOptions}
            selectedModelForPickerWithCustomFallback={
              props.selectedModelForPickerWithCustomFallback
            }
            lockedProvider={props.lockedProvider}
            providers={props.providers}
            modelOptionsByProvider={props.modelOptionsByProvider}
            isServerThread={props.isServerThread}
            handoffTargetProviders={props.handoffTargetProviders}
            handoffDisabled={props.handoffDisabled}
            interactionMode={props.interactionMode}
            runtimeMode={props.runtimeMode}
            interactionModeShortcutLabel={props.interactionModeShortcutLabel}
            activeContextWindow={props.activeContextWindow}
            promptHasText={prompt.trim().length > 0}
            hasSendableContent={composerSendState.hasSendableContent}
            canQueueMessage={composerSendState.hasSendableContent && props.allowQueueWhenSendable}
            activePendingApproval={props.activePendingApproval}
            pendingApprovalsCount={props.pendingApprovalsCount}
            pendingUserInputs={props.pendingUserInputs}
            respondingApprovalRequestIds={props.respondingApprovalRequestIds}
            respondingUserInputRequestIds={props.respondingUserInputRequestIds}
            activePendingDraftAnswers={props.activePendingDraftAnswers}
            activePendingQuestionIndex={props.activePendingQuestionIndex}
            activePendingProgress={props.activePendingProgress}
            activePendingIsResponding={props.activePendingIsResponding}
            activePendingResolvedAnswers={props.activePendingResolvedAnswers}
            planFollowUpId={props.planFollowUpId}
            planFollowUpTitle={props.planFollowUpTitle}
            resolvedTheme={props.resolvedTheme}
            composerFormRef={composerFormRef}
            composerEditorRef={composerEditorRef}
            composerFooterRef={composerFooterRef}
            composerFooterLeadingRef={composerFooterLeadingRef}
            composerFooterActionsRef={composerFooterActionsRef}
            onSubmit={props.onSubmit}
            onComposerDragEnter={onComposerDragEnter}
            onComposerDragOver={onComposerDragOver}
            onComposerDragLeave={onComposerDragLeave}
            onComposerDrop={onComposerDrop}
            onHighlightedItemChange={setComposerHighlightedItemId}
            onSelectComposerItem={onSelectComposerItem}
            onEditQueuedComposerMessage={props.onEditQueuedComposerMessage}
            onDeleteQueuedComposerMessage={props.onDeleteQueuedComposerMessage}
            onClearQueuedComposerMessages={props.onClearQueuedComposerMessages}
            onReorderQueuedComposerMessages={props.onReorderQueuedComposerMessages}
            onSteerQueuedComposerMessage={props.onSteerQueuedComposerMessage}
            onPreviewComposerImage={onPreviewComposerImage}
            onRemoveComposerImage={removeComposerImage}
            onRemoveTerminalContext={(contextId) =>
              removeComposerDraftTerminalContext(props.threadId, contextId)
            }
            onPromptChange={onPromptChange}
            onCommandKeyDown={onComposerCommandKey}
            onIssueTokenClick={props.onIssuePreviewOpen}
            onPaste={onComposerPaste}
            onRespondToApproval={props.onRespondToApproval}
            onSelectPendingUserInputOption={props.onSelectPendingUserInputOption}
            onAdvancePendingUserInput={props.onAdvancePendingUserInput}
            onProviderModelSelect={onProviderModelSelect}
            onHandoffToProvider={props.onHandoffToProvider}
            onToggleInteractionMode={props.onToggleInteractionMode}
            onRuntimeModeChange={props.onRuntimeModeChange}
            onPreviousPendingQuestion={props.onPreviousPendingQuestion}
            onInterrupt={props.onInterrupt}
            onImplementPlanInNewThread={props.onImplementPlanInNewThread}
            onQueueMessage={props.onQueueMessage}
            onPromptChangeFromTraits={setPromptFromTraits}
          />
          {props.showFloatingDock ? (
            <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-20">
              <ChatComposerPanel
                threadId={props.threadId}
                isGitRepo={props.isGitRepo}
                isDragOverComposer={isDragOverComposer}
                hasComposerHeader={hasComposerHeader}
                isComposerApprovalState={isComposerApprovalState}
                isComposerFooterCompact={isComposerFooterCompact}
                isComposerPrimaryActionsCompact={isComposerPrimaryActionsCompact}
                isComposerMenuLoading={isComposerMenuLoading}
                composerMenuOpen={composerMenuOpen}
                showIssuesCommandExamplesPopover={showIssuesCommandExamplesPopover}
                isConnecting={props.isConnecting}
                isPreparingWorktree={props.isPreparingWorktree}
                liveTurnInProgress={props.liveTurnInProgress}
                isSendBusy={props.isSendBusy}
                showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                showQueue={true}
                prompt={prompt}
                composerCursor={composerCursor}
                composerTriggerKind={composerTriggerKind}
                composerMenuItems={composerMenuItems}
                activeComposerMenuItemId={activeComposerMenuItem?.id ?? null}
                composerImages={composerImages}
                nonPersistedComposerImageIdSet={nonPersistedComposerImageIdSet}
                composerTerminalContexts={composerTerminalContexts}
                queuedComposerMessages={props.queuedComposerMessages}
                queuedSteerMessageId={props.queuedSteerMessageId}
                composerProviderState={composerProviderState}
                selectedProvider={props.selectedProvider}
                selectedModel={props.selectedModel}
                selectedProviderModels={props.selectedProviderModels}
                selectedProviderModelOptions={props.selectedProviderModelOptions}
                selectedModelForPickerWithCustomFallback={
                  props.selectedModelForPickerWithCustomFallback
                }
                lockedProvider={props.lockedProvider}
                providers={props.providers}
                modelOptionsByProvider={props.modelOptionsByProvider}
                isServerThread={props.isServerThread}
                handoffTargetProviders={props.handoffTargetProviders}
                handoffDisabled={props.handoffDisabled}
                interactionMode={props.interactionMode}
                runtimeMode={props.runtimeMode}
                interactionModeShortcutLabel={props.interactionModeShortcutLabel}
                activeContextWindow={props.activeContextWindow}
                promptHasText={prompt.trim().length > 0}
                hasSendableContent={composerSendState.hasSendableContent}
                canQueueMessage={
                  composerSendState.hasSendableContent && props.allowQueueWhenSendable
                }
                activePendingApproval={props.activePendingApproval}
                pendingApprovalsCount={props.pendingApprovalsCount}
                pendingUserInputs={props.pendingUserInputs}
                respondingApprovalRequestIds={props.respondingApprovalRequestIds}
                respondingUserInputRequestIds={props.respondingUserInputRequestIds}
                activePendingDraftAnswers={props.activePendingDraftAnswers}
                activePendingQuestionIndex={props.activePendingQuestionIndex}
                activePendingProgress={props.activePendingProgress}
                activePendingIsResponding={props.activePendingIsResponding}
                activePendingResolvedAnswers={props.activePendingResolvedAnswers}
                planFollowUpId={props.planFollowUpId}
                planFollowUpTitle={props.planFollowUpTitle}
                resolvedTheme={props.resolvedTheme}
                composerFormRef={floatingComposerFormRef}
                composerEditorRef={floatingComposerEditorRef}
                composerFooterRef={floatingComposerFooterRef}
                composerFooterLeadingRef={floatingComposerFooterLeadingRef}
                composerFooterActionsRef={floatingComposerFooterActionsRef}
                onSubmit={props.onSubmit}
                onComposerDragEnter={onComposerDragEnter}
                onComposerDragOver={onComposerDragOver}
                onComposerDragLeave={onComposerDragLeave}
                onComposerDrop={onComposerDrop}
                onHighlightedItemChange={setComposerHighlightedItemId}
                onSelectComposerItem={onSelectComposerItem}
                onEditQueuedComposerMessage={props.onEditQueuedComposerMessage}
                onDeleteQueuedComposerMessage={props.onDeleteQueuedComposerMessage}
                onClearQueuedComposerMessages={props.onClearQueuedComposerMessages}
                onReorderQueuedComposerMessages={props.onReorderQueuedComposerMessages}
                onSteerQueuedComposerMessage={props.onSteerQueuedComposerMessage}
                onPreviewComposerImage={onPreviewComposerImage}
                onRemoveComposerImage={removeComposerImage}
                onRemoveTerminalContext={(contextId) =>
                  removeComposerDraftTerminalContext(props.threadId, contextId)
                }
                onPromptChange={onPromptChange}
                onCommandKeyDown={onComposerCommandKey}
                onIssueTokenClick={props.onIssuePreviewOpen}
                onPaste={onComposerPaste}
                onRespondToApproval={props.onRespondToApproval}
                onSelectPendingUserInputOption={props.onSelectPendingUserInputOption}
                onAdvancePendingUserInput={props.onAdvancePendingUserInput}
                onProviderModelSelect={onProviderModelSelect}
                onHandoffToProvider={props.onHandoffToProvider}
                onToggleInteractionMode={props.onToggleInteractionMode}
                onRuntimeModeChange={props.onRuntimeModeChange}
                onPreviousPendingQuestion={props.onPreviousPendingQuestion}
                onInterrupt={props.onInterrupt}
                onImplementPlanInNewThread={props.onImplementPlanInNewThread}
                onQueueMessage={props.onQueueMessage}
                onPromptChangeFromTraits={setPromptFromTraits}
              />
              {props.floatingDockFooter ?? null}
            </div>
          ) : null}
        </>
      );
    },
  ),
);
