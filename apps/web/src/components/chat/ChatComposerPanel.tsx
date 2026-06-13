import type {
  ProviderKind,
  ProviderInteractionMode,
  ProviderModelOptions,
  ProviderSessionConfigOption,
  RuntimeMode,
  ServerProvider,
  ServerProviderModel,
  ThreadHandoffMode,
  ThreadId,
} from "@ace/contracts";
import {
  BotIcon,
  CircleAlertIcon,
  ListTodoIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import {
  useMemo,
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type FormEvent,
  type RefObject,
} from "react";

import {
  APP_COMPOSER_CLASS_NAME,
  APP_COMPOSER_HEADER_CLASS_NAME,
  APP_WORKSPACE_INSET_CLASS_NAME,
} from "../../lib/appChrome";
import type { ComposerImageAttachment, ModelSelectionByProvider } from "../../composerDraftStore";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import { cn } from "../../lib/utils";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingComments } from "./ComposerPendingComments";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerQueuedMessages } from "./ComposerQueuedMessages";
import {
  type ComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderRegistry";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { nextRuntimeMode, RUNTIME_MODE_META } from "./runtimeModeControl";

const EMPTY_TERMINAL_CONTEXTS: ComponentProps<typeof ComposerPromptEditor>["terminalContexts"] = [];

function renderInteractionModeTooltipContent(
  interactionMode: ProviderInteractionMode,
  shortcutLabel: string | null,
) {
  return (
    <span className="inline-flex items-center gap-2">
      <span>{interactionMode === "plan" ? "Switch to Agent" : "Switch to Plan"}</span>
      {shortcutLabel ? (
        <Kbd className="h-4.5 min-w-0 rounded-md bg-background/70 px-1.5 text-[10px] text-foreground/75 dark:bg-background/25">
          {shortcutLabel}
        </Kbd>
      ) : null}
    </span>
  );
}

function RuntimeModeButton(props: {
  runtimeMode: RuntimeMode;
  compact: boolean;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            className={cn(
              "shrink-0 whitespace-nowrap px-2 transition-colors duration-150 sm:px-2.5",
              RUNTIME_MODE_META[props.runtimeMode].textClassName,
            )}
            size="sm"
            type="button"
            onClick={() => props.onRuntimeModeChange(nextRuntimeMode(props.runtimeMode))}
            aria-label={RUNTIME_MODE_META[props.runtimeMode].title}
            data-chat-composer-runtime-mode={props.runtimeMode}
          />
        }
      >
        {props.runtimeMode === "full-access" ? (
          <ShieldAlertIcon
            className={cn("size-4", RUNTIME_MODE_META[props.runtimeMode].iconClassName)}
          />
        ) : (
          <ShieldCheckIcon
            className={cn("size-4", RUNTIME_MODE_META[props.runtimeMode].iconClassName)}
          />
        )}
        <span className={props.compact ? "sr-only" : "sr-only sm:not-sr-only"}>
          {RUNTIME_MODE_META[props.runtimeMode].label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top" sideOffset={4}>
        {RUNTIME_MODE_META[props.runtimeMode].title}
      </TooltipPopup>
    </Tooltip>
  );
}

interface ChatComposerPanelProps {
  readonly threadId: ThreadId;
  readonly isGitRepo: boolean;
  readonly isDragOverComposer: boolean;
  readonly hasComposerHeader: boolean;
  readonly isComposerApprovalState: boolean;
  readonly isComposerFooterCompact: boolean;
  readonly isComposerPrimaryActionsCompact: boolean;
  readonly isComposerMenuLoading: boolean;
  readonly composerMenuOpen: boolean;
  readonly showIssuesCommandExamplesPopover: boolean;
  readonly isConnecting: boolean;
  readonly isPreparingWorktree: boolean;
  readonly liveTurnInProgress: boolean;
  readonly isSendBusy: boolean;
  readonly showPlanFollowUpPrompt: boolean;
  readonly showQueue?: boolean;
  readonly placeholderOverride?: string | undefined;
  readonly prompt: string;
  readonly composerCursor: ComponentProps<typeof ComposerPromptEditor>["cursor"];
  readonly composerTriggerKind: ComponentProps<typeof ComposerCommandMenu>["triggerKind"];
  readonly composerMenuItems: ComponentProps<typeof ComposerCommandMenu>["items"];
  readonly activeComposerMenuItemId: string | null;
  readonly composerImages: ReadonlyArray<ComposerImageAttachment>;
  readonly nonPersistedComposerImageIdSet: ReadonlySet<string>;
  readonly composerTerminalContexts: ComponentProps<
    typeof ComposerPromptEditor
  >["terminalContexts"];
  readonly queuedComposerMessages: ComponentProps<typeof ComposerQueuedMessages>["messages"];
  readonly queuedSteerMessageId: ComponentProps<typeof ComposerQueuedMessages>["steerMessageId"];
  readonly canSendQueuedMessages: boolean;
  readonly pendingComposerComments: ComponentProps<typeof ComposerPendingComments>["comments"];
  readonly composerProviderState: ComposerProviderState;
  readonly selectedProvider: ProviderKind;
  readonly selectedProviderInstanceId?: string | undefined;
  readonly selectedModel: string;
  readonly selectedProviderModels: ReadonlyArray<ServerProviderModel>;
  readonly selectedProviderModelOptions: ProviderModelOptions[ProviderKind] | undefined;
  readonly sessionConfigOptions?: ReadonlyArray<ProviderSessionConfigOption> | undefined;
  readonly selectedModelForPickerWithCustomFallback: string;
  readonly lockedProvider: ProviderKind | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelOptionsByProvider: ComponentProps<
    typeof ProviderModelPicker
  >["modelOptionsByProvider"];
  readonly modelSelectionByProvider?: ModelSelectionByProvider | undefined;
  readonly providerInstancesByProvider?: ComponentProps<
    typeof ProviderModelPicker
  >["providerInstancesByProvider"];
  readonly isServerThread: boolean;
  readonly handoffTargetProviders: ReadonlyArray<ProviderKind>;
  readonly handoffDisabled: boolean;
  readonly interactionMode: ComponentProps<typeof CompactComposerControlsMenu>["interactionMode"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionModeShortcutLabel: string | null;
  readonly activeContextWindow: ComponentProps<typeof ContextWindowMeter>["usage"] | null;
  readonly promptHasText: boolean;
  readonly hasSendableContent: boolean;
  readonly canQueueMessage: boolean;
  readonly activePendingApproval:
    | ComponentProps<typeof ComposerPendingApprovalPanel>["approval"]
    | null;
  readonly pendingApprovalsCount: number;
  readonly pendingUserInputs: ComponentProps<
    typeof ComposerPendingUserInputPanel
  >["pendingUserInputs"];
  readonly respondingApprovalRequestIds: ReadonlyArray<string>;
  readonly respondingUserInputRequestIds: ComponentProps<
    typeof ComposerPendingUserInputPanel
  >["respondingRequestIds"];
  readonly activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingQuestionIndex: number;
  readonly activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
  } | null;
  readonly activePendingIsResponding: boolean;
  readonly activePendingResolvedAnswers: unknown;
  readonly planFollowUpId: string | null;
  readonly planFollowUpTitle: string | null;
  readonly resolvedTheme: ComponentProps<typeof ComposerCommandMenu>["resolvedTheme"];
  readonly composerFormRef: RefObject<HTMLFormElement | null>;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly composerFooterRef: RefObject<HTMLDivElement | null>;
  readonly composerFooterLeadingRef: RefObject<HTMLDivElement | null>;
  readonly composerFooterActionsRef: RefObject<HTMLDivElement | null>;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onComposerDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  readonly onComposerDragOver: (event: DragEvent<HTMLDivElement>) => void;
  readonly onComposerDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onHighlightedItemChange: ComponentProps<
    typeof ComposerCommandMenu
  >["onHighlightedItemChange"];
  readonly onSelectComposerItem: ComponentProps<typeof ComposerCommandMenu>["onSelect"];
  readonly onEditQueuedComposerMessage: ComponentProps<typeof ComposerQueuedMessages>["onEdit"];
  readonly onDeleteQueuedComposerMessage: ComponentProps<typeof ComposerQueuedMessages>["onDelete"];
  readonly onClearQueuedComposerMessages: ComponentProps<
    typeof ComposerQueuedMessages
  >["onClearAll"];
  readonly onDismissPendingComposerComment: ComponentProps<
    typeof ComposerPendingComments
  >["onDismiss"];
  readonly onClearPendingComposerComments: ComponentProps<
    typeof ComposerPendingComments
  >["onClearAll"];
  readonly onReorderQueuedComposerMessages: ComponentProps<
    typeof ComposerQueuedMessages
  >["onReorder"];
  readonly onSendQueuedComposerMessage: NonNullable<
    ComponentProps<typeof ComposerQueuedMessages>["onSend"]
  >;
  readonly onSteerQueuedComposerMessage: ComponentProps<typeof ComposerQueuedMessages>["onSteer"];
  readonly onPreviewComposerImage: (imageId: string) => void;
  readonly onRemoveComposerImage: (imageId: string) => void;
  readonly onRemoveTerminalContext: ComponentProps<
    typeof ComposerPromptEditor
  >["onRemoveTerminalContext"];
  readonly onPromptChange: ComponentProps<typeof ComposerPromptEditor>["onChange"];
  readonly onCommandKeyDown: NonNullable<
    ComponentProps<typeof ComposerPromptEditor>["onCommandKeyDown"]
  >;
  readonly onIssueTokenClick: NonNullable<
    ComponentProps<typeof ComposerPromptEditor>["onIssueTokenClick"]
  >;
  readonly onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  readonly onRespondToApproval: ComponentProps<
    typeof ComposerPendingApprovalActions
  >["onRespondToApproval"];
  readonly onSelectPendingUserInputOption: ComponentProps<
    typeof ComposerPendingUserInputPanel
  >["onSelectOption"];
  readonly onAdvancePendingUserInput: ComponentProps<
    typeof ComposerPendingUserInputPanel
  >["onAdvance"];
  readonly onProviderModelSelect: (
    provider: ProviderKind,
    model: string,
    providerInstanceId?: string,
  ) => void;
  readonly onHandoffToProvider: (provider: ProviderKind, mode: ThreadHandoffMode) => void;
  readonly onToggleInteractionMode: () => void;
  readonly onRuntimeModeChange: (mode: RuntimeMode) => void;
  readonly onPreviousPendingQuestion: () => void;
  readonly onInterrupt: () => void;
  readonly onImplementPlanInNewThread: () => void;
  readonly onQueueMessage: () => void;
  readonly onPromptChangeFromTraits: (prompt: string) => void;
}

function ComposerImageStrip(props: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly nonPersistedImageIds: ReadonlySet<string>;
  readonly onPreview: (imageId: string) => void;
  readonly onRemove: (imageId: string) => void;
}) {
  if (props.images.length === 0) {
    return null;
  }

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {props.images.map((image) => (
        <div
          key={image.id}
          className="relative size-16 overflow-hidden rounded-lg border border-border/80 bg-background"
        >
          {image.previewUrl ? (
            <button
              type="button"
              className="h-full w-full cursor-zoom-in"
              aria-label={`Preview ${image.name}`}
              onClick={() => props.onPreview(image.id)}
            >
              <img src={image.previewUrl} alt={image.name} className="h-full w-full object-cover" />
            </button>
          ) : (
            <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
              {image.name}
            </div>
          )}
          {props.nonPersistedImageIds.has(image.id) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600">
                    <CircleAlertIcon
                      className="size-3"
                      aria-label="Draft attachment may not persist"
                    />
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
                Draft attachment could not be saved locally and may be lost on navigation.
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
            onClick={() => props.onRemove(image.id)}
            aria-label={`Remove ${image.name}`}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function ChatComposerPanel({
  composerEditorRef,
  composerFooterActionsRef,
  composerFooterLeadingRef,
  composerFooterRef,
  composerFormRef,
  ...props
}: ChatComposerPanelProps) {
  const interactionModeDisabledReason = null;
  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: props.selectedProvider,
    threadId: props.threadId,
    model: props.selectedModel,
    models: props.selectedProviderModels,
    modelOptions: props.selectedProviderModelOptions,
    prompt: props.prompt,
    onPromptChange: props.onPromptChangeFromTraits,
    sessionConfigOptions: props.sessionConfigOptions,
  });
  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: props.selectedProvider,
    threadId: props.threadId,
    model: props.selectedModel,
    models: props.selectedProviderModels,
    modelOptions: props.selectedProviderModelOptions,
    prompt: props.prompt,
    onPromptChange: props.onPromptChangeFromTraits,
    showFastInTriggerLabel: false,
    sessionConfigOptions: props.sessionConfigOptions,
  });
  const composerValue = props.isComposerApprovalState
    ? ""
    : (props.activePendingProgress?.customAnswer ?? props.prompt);
  const composerTerminalContexts =
    !props.isComposerApprovalState && props.pendingUserInputs.length === 0
      ? props.composerTerminalContexts
      : EMPTY_TERMINAL_CONTEXTS;
  const placeholder = props.isComposerApprovalState
    ? (props.activePendingApproval?.detail ?? "Resolve this approval request to continue")
    : props.activePendingProgress
      ? "Custom answer, or leave blank to use the selected option"
      : props.showPlanFollowUpPrompt && props.planFollowUpId
        ? "Feedback to refine the plan, or blank to implement"
        : props.placeholderOverride
          ? props.placeholderOverride
          : "Ask or follow-up changes";
  const pendingAction = props.activePendingProgress
    ? {
        questionIndex: props.activePendingProgress.questionIndex,
        isLastQuestion: props.activePendingProgress.isLastQuestion,
        canAdvance: props.activePendingProgress.canAdvance,
        isResponding: props.activePendingIsResponding,
        isComplete: Boolean(props.activePendingResolvedAnswers),
      }
    : null;
  const handoff = useMemo<ComponentProps<typeof ProviderModelPicker>["handoff"]>(() => {
    if (
      !props.isServerThread ||
      props.handoffDisabled ||
      props.handoffTargetProviders.length === 0
    ) {
      return undefined;
    }

    return {
      providers: props.handoffTargetProviders,
      disabled: false,
      onSelect: props.onHandoffToProvider,
    };
  }, [
    props.handoffDisabled,
    props.handoffTargetProviders,
    props.isServerThread,
    props.onHandoffToProvider,
  ]);

  const isUltrathinkFrame =
    props.composerProviderState.composerFrameClassName === "ultrathink-frame";

  return (
    <div
      className={cn(
        "shrink-0 px-3 pt-0 sm:px-5 sm:pt-0",
        props.isGitRepo ? "pb-1.5" : "pb-3 sm:pb-4",
      )}
    >
      <form
        ref={composerFormRef}
        onSubmit={props.onSubmit}
        className="mx-auto w-full min-w-0 max-w-208"
        data-chat-composer-form="true"
      >
        {(props.showQueue ?? true) ? (
          <>
            <ComposerPendingComments
              comments={props.pendingComposerComments}
              className="mb-2"
              onDismiss={props.onDismissPendingComposerComment}
              onClearAll={props.onClearPendingComposerComments}
            />
            <ComposerQueuedMessages
              messages={props.queuedComposerMessages}
              className="mb-2"
              {...(props.queuedSteerMessageId !== undefined
                ? { steerMessageId: props.queuedSteerMessageId }
                : {})}
              onEdit={props.onEditQueuedComposerMessage}
              onDelete={props.onDeleteQueuedComposerMessage}
              onClearAll={props.onClearQueuedComposerMessages}
              onReorder={props.onReorderQueuedComposerMessages}
              canSendNow={props.canSendQueuedMessages}
              onSend={props.onSendQueuedComposerMessage}
              onSteer={props.onSteerQueuedComposerMessage}
            />
          </>
        ) : null}
        {props.pendingUserInputs.length > 0 ? (
          <div className="mb-2">
            <ComposerPendingUserInputPanel
              pendingUserInputs={props.pendingUserInputs}
              respondingRequestIds={props.respondingUserInputRequestIds}
              answers={props.activePendingDraftAnswers}
              questionIndex={props.activePendingQuestionIndex}
              onSelectOption={props.onSelectPendingUserInputOption}
              onPrevious={props.onPreviousPendingQuestion}
              onAdvance={props.onAdvancePendingUserInput}
            />
          </div>
        ) : null}

        <div
          className={cn(
            "group rounded-xl transition-colors duration-200",
            isUltrathinkFrame && "p-px",
            props.composerProviderState.composerFrameClassName,
          )}
          onDragEnter={props.onComposerDragEnter}
          onDragOver={props.onComposerDragOver}
          onDragLeave={props.onComposerDragLeave}
          onDrop={props.onComposerDrop}
        >
          <div
            className={cn(
              "rounded-xl",
              isUltrathinkFrame
                ? "border-0 bg-input transition-all duration-200 focus-within:ring-2 focus-within:ring-ring/40"
                : APP_COMPOSER_CLASS_NAME,
              props.isDragOverComposer && "bg-primary/8",
              props.composerProviderState.composerSurfaceClassName,
            )}
          >
            {props.activePendingApproval ? (
              <div className={APP_COMPOSER_HEADER_CLASS_NAME}>
                <ComposerPendingApprovalPanel
                  approval={props.activePendingApproval}
                  pendingCount={props.pendingApprovalsCount}
                />
              </div>
            ) : props.showPlanFollowUpPrompt && props.planFollowUpId ? (
              <div className={APP_COMPOSER_HEADER_CLASS_NAME}>
                <ComposerPlanFollowUpBanner
                  key={props.planFollowUpId}
                  planTitle={props.planFollowUpTitle}
                />
              </div>
            ) : null}
            <div
              className={cn(
                "relative px-3 pb-2 sm:px-4",
                props.hasComposerHeader ? "pt-2 sm:pt-2.5" : "pt-2 sm:pt-2.5",
              )}
            >
              {props.composerMenuOpen && !props.isComposerApprovalState ? (
                <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                  <ComposerCommandMenu
                    items={props.composerMenuItems}
                    resolvedTheme={props.resolvedTheme}
                    isLoading={props.isComposerMenuLoading}
                    triggerKind={props.composerTriggerKind}
                    activeItemId={props.activeComposerMenuItemId}
                    onHighlightedItemChange={props.onHighlightedItemChange}
                    onSelect={props.onSelectComposerItem}
                  />
                </div>
              ) : null}
              {props.showIssuesCommandExamplesPopover ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                  <div className="glass-surface rounded-lg border px-3 py-2">
                    <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                      Use <span className="font-mono text-foreground">/issues</span> with issue
                      tags:
                    </p>
                    <div className="space-y-1">
                      <div
                        className={cn(
                          APP_WORKSPACE_INSET_CLASS_NAME,
                          "px-2 py-1 font-mono text-[11px] text-foreground/90",
                        )}
                      >
                        /issues #[issue_no] [message]
                      </div>
                      <div
                        className={cn(
                          APP_WORKSPACE_INSET_CLASS_NAME,
                          "px-2 py-1 font-mono text-[11px] text-foreground/90",
                        )}
                      >
                        /issues #123 #456 [message]
                      </div>
                      <div
                        className={cn(
                          APP_WORKSPACE_INSET_CLASS_NAME,
                          "px-2 py-1 font-mono text-[11px] text-foreground/90",
                        )}
                      >
                        /issues #123 Fix timeline jitter in chat view
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {!props.isComposerApprovalState && props.pendingUserInputs.length === 0 ? (
                <ComposerImageStrip
                  images={props.composerImages}
                  nonPersistedImageIds={props.nonPersistedComposerImageIdSet}
                  onPreview={props.onPreviewComposerImage}
                  onRemove={props.onRemoveComposerImage}
                />
              ) : null}

              <ComposerPromptEditor
                ref={composerEditorRef}
                value={composerValue}
                cursor={props.composerCursor}
                terminalContexts={composerTerminalContexts}
                onRemoveTerminalContext={props.onRemoveTerminalContext}
                onChange={props.onPromptChange}
                onCommandKeyDown={props.onCommandKeyDown}
                onIssueTokenClick={props.onIssueTokenClick}
                onPaste={props.onPaste}
                placeholder={placeholder}
                {...(props.placeholderOverride
                  ? {
                      className: "new-thread-start-composer-editor",
                      placeholderClassName: "new-thread-start-composer-placeholder",
                    }
                  : {})}
                disabled={props.isConnecting || props.isComposerApprovalState}
              />
            </div>

            {props.activePendingApproval ? (
              <div className="flex items-center justify-end gap-2 px-2.5 pb-2 sm:px-3 sm:pb-2.5">
                <ComposerPendingApprovalActions
                  requestId={props.activePendingApproval.requestId}
                  isResponding={props.respondingApprovalRequestIds.includes(
                    props.activePendingApproval.requestId,
                  )}
                  onRespondToApproval={props.onRespondToApproval}
                />
              </div>
            ) : (
              <div
                ref={composerFooterRef}
                data-chat-composer-footer="true"
                data-chat-composer-footer-compact={props.isComposerFooterCompact ? "true" : "false"}
                className={cn(
                  "flex min-w-0 flex-nowrap items-center justify-between overflow-hidden px-2.5 pb-2 sm:px-3 sm:pb-2.5",
                  props.isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                )}
              >
                <div
                  ref={composerFooterLeadingRef}
                  className={cn(
                    "flex min-w-0 flex-1 items-center",
                    props.isComposerFooterCompact
                      ? "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                      : "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                  )}
                >
                  <ProviderModelPicker
                    compact={props.isComposerFooterCompact}
                    provider={props.selectedProvider}
                    {...(props.selectedProviderInstanceId
                      ? { providerInstanceId: props.selectedProviderInstanceId }
                      : {})}
                    model={props.selectedModelForPickerWithCustomFallback}
                    lockedProvider={props.lockedProvider}
                    providers={props.providers}
                    modelOptionsByProvider={props.modelOptionsByProvider}
                    {...(props.modelSelectionByProvider
                      ? { modelSelectionByProvider: props.modelSelectionByProvider }
                      : {})}
                    {...(props.providerInstancesByProvider
                      ? { providerInstancesByProvider: props.providerInstancesByProvider }
                      : {})}
                    {...(props.composerProviderState.modelPickerIconClassName
                      ? {
                          activeProviderIconClassName:
                            props.composerProviderState.modelPickerIconClassName,
                        }
                      : {})}
                    onProviderModelChange={props.onProviderModelSelect}
                    {...(handoff ? { handoff } : {})}
                  />

                  {props.isComposerFooterCompact ? (
                    <CompactComposerControlsMenu
                      interactionMode={props.interactionMode}
                      interactionModeShortcutLabel={props.interactionModeShortcutLabel}
                      interactionModeDisabledReason={interactionModeDisabledReason}
                      traitsMenuContent={providerTraitsMenuContent}
                      onToggleInteractionMode={props.onToggleInteractionMode}
                    />
                  ) : (
                    <>
                      {providerTraitsPicker ? (
                        <>
                          <Separator
                            orientation="vertical"
                            className="mx-0.5 hidden h-3.5 bg-border/30 sm:block"
                          />
                          {providerTraitsPicker}
                        </>
                      ) : null}

                      <Separator
                        orientation="vertical"
                        className="mx-0.5 hidden h-3.5 bg-border/30 sm:block"
                      />

                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/60 transition-colors duration-150 hover:text-foreground/70 sm:px-2.5"
                              size="sm"
                              type="button"
                              onClick={props.onToggleInteractionMode}
                              disabled={Boolean(interactionModeDisabledReason)}
                              aria-label={
                                props.interactionMode === "plan"
                                  ? "Switch to agent mode"
                                  : "Switch to plan mode"
                              }
                            />
                          }
                        >
                          {props.interactionMode === "plan" ? (
                            <ListTodoIcon className="size-4" />
                          ) : (
                            <BotIcon className="size-4" />
                          )}
                          <span className="sr-only sm:not-sr-only">
                            {props.interactionMode === "plan" ? "Plan" : "Agent"}
                          </span>
                        </TooltipTrigger>
                        <TooltipPopup side="top" sideOffset={4}>
                          {interactionModeDisabledReason ??
                            renderInteractionModeTooltipContent(
                              props.interactionMode,
                              props.interactionModeShortcutLabel,
                            )}
                        </TooltipPopup>
                      </Tooltip>
                    </>
                  )}
                </div>

                <div
                  ref={composerFooterActionsRef}
                  data-chat-composer-actions="right"
                  data-chat-composer-primary-actions-compact={
                    props.isComposerPrimaryActionsCompact ? "true" : "false"
                  }
                  className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                >
                  <RuntimeModeButton
                    runtimeMode={props.runtimeMode}
                    compact={props.isComposerFooterCompact || props.isComposerPrimaryActionsCompact}
                    onRuntimeModeChange={props.onRuntimeModeChange}
                  />
                  {props.activeContextWindow ? (
                    <ContextWindowMeter usage={props.activeContextWindow} />
                  ) : null}
                  {props.isPreparingWorktree ? (
                    <span className="text-muted-foreground/70 text-xs">Preparing worktree…</span>
                  ) : null}
                  <ComposerPrimaryActions
                    compact={props.isComposerPrimaryActionsCompact}
                    pendingAction={pendingAction}
                    isRunning={props.liveTurnInProgress}
                    showPlanFollowUpPrompt={
                      props.pendingUserInputs.length === 0 && props.showPlanFollowUpPrompt
                    }
                    promptHasText={props.promptHasText}
                    isSendBusy={props.isSendBusy}
                    isConnecting={props.isConnecting}
                    isPreparingWorktree={props.isPreparingWorktree}
                    hasSendableContent={props.hasSendableContent}
                    canQueueMessage={props.canQueueMessage}
                    onInterrupt={props.onInterrupt}
                    onImplementPlanInNewThread={props.onImplementPlanInNewThread}
                    onQueueMessage={props.onQueueMessage}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
