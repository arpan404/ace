import "../../index.css";

import {
  ApprovalRequestId,
  type ProviderKind,
  type ServerProvider,
  ThreadId,
  type RuntimeMode,
} from "@ace/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";
import { type ComponentProps, createRef } from "react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { collapseExpandedComposerCursor } from "../../composer-logic";
import { getCustomModelOptionsByProvider } from "../../modelSelection";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ChatComposerPanel } from "./ChatComposerPanel";

function effort(value: string, isDefault = false) {
  return {
    value,
    label: value,
    ...(isDefault ? { isDefault: true } : {}),
  };
}

const TEST_PROVIDER: ServerProvider = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: "0.116.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: new Date().toISOString(),
  models: [
    {
      slug: "gpt-5-codex",
      name: "GPT-5 Codex",
      isCustom: false,
      capabilities: {
        reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    },
  ],
};

const TEST_PROVIDERS = [TEST_PROVIDER];

function buildPanelProps(
  overrides?: Partial<ComponentProps<typeof ChatComposerPanel>>,
): ComponentProps<typeof ChatComposerPanel> {
  const provider: ProviderKind = "codex";
  const runtimeMode: RuntimeMode = "full-access";
  const model = "gpt-5-codex";

  return {
    threadId: ThreadId.makeUnsafe("thread-composer-panel"),
    isGitRepo: true,
    isDragOverComposer: false,
    hasComposerHeader: false,
    isComposerApprovalState: false,
    isComposerFooterCompact: false,
    isComposerPrimaryActionsCompact: false,
    isComposerMenuLoading: false,
    composerMenuOpen: false,
    showIssuesCommandExamplesPopover: false,
    isConnecting: false,
    isPreparingWorktree: false,
    liveTurnInProgress: false,
    isSendBusy: false,
    showPlanFollowUpPrompt: false,
    showQueue: false,
    prompt: "",
    composerCursor: collapseExpandedComposerCursor("", 0),
    composerTriggerKind: null,
    composerMenuItems: [],
    activeComposerMenuItemId: null,
    composerImages: [],
    nonPersistedComposerImageIdSet: new Set(),
    composerTerminalContexts: [],
    queuedComposerMessages: [],
    queuedSteerMessageId: null,
    queuedDispatchingMessageId: null,
    canSendQueuedMessages: false,
    pendingComposerComments: [],
    composerProviderState: {
      provider,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    },
    selectedProvider: provider,
    selectedModel: model,
    selectedProviderModels: TEST_PROVIDER.models,
    selectedProviderModelOptions: undefined,
    selectedModelForPickerWithCustomFallback: model,
    lockedProvider: null,
    providers: TEST_PROVIDERS,
    modelOptionsByProvider: getCustomModelOptionsByProvider(
      DEFAULT_UNIFIED_SETTINGS,
      TEST_PROVIDERS,
      provider,
      model,
    ),
    isServerThread: true,
    handoffTargetProviders: [],
    handoffDisabled: false,
    interactionMode: "default",
    interactionModeShortcutLabel: "Shift + Tab",
    runtimeMode,
    skillCommands: [],
    pluginCommands: [],
    activeContextWindow: null,
    promptHasText: false,
    hasSendableContent: false,
    canQueueMessage: false,
    activePendingApproval: null,
    pendingApprovalsCount: 0,
    pendingUserInputs: [],
    respondingApprovalRequestIds: [],
    respondingUserInputRequestIds: [],
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    activePendingProgress: null,
    activePendingIsResponding: false,
    activePendingResolvedAnswers: null,
    planFollowUpId: null,
    planFollowUpTitle: null,
    resolvedTheme: "dark",
    composerFormRef: createRef<HTMLFormElement>(),
    composerEditorRef: createRef<ComposerPromptEditorHandle>(),
    composerFooterRef: createRef<HTMLDivElement>(),
    composerFooterLeadingRef: createRef<HTMLDivElement>(),
    composerFooterActionsRef: createRef<HTMLDivElement>(),
    onSubmit: vi.fn((event) => event.preventDefault()),
    onComposerDragEnter: vi.fn(),
    onComposerDragOver: vi.fn(),
    onComposerDragLeave: vi.fn(),
    onComposerDrop: vi.fn(),
    onHighlightedItemChange: vi.fn(),
    onSelectComposerItem: vi.fn(),
    onEditQueuedComposerMessage: vi.fn(),
    onDeleteQueuedComposerMessage: vi.fn(),
    onClearQueuedComposerMessages: vi.fn(),
    onDismissPendingComposerComment: vi.fn(),
    onClearPendingComposerComments: vi.fn(),
    onReorderQueuedComposerMessages: vi.fn(),
    onSendQueuedComposerMessage: vi.fn(),
    onSteerQueuedComposerMessage: vi.fn(),
    onPreviewComposerImage: vi.fn(),
    onRemoveComposerImage: vi.fn(),
    onRemoveTerminalContext: vi.fn(),
    onPromptChange: vi.fn(),
    onCommandKeyDown: vi.fn(() => false),
    onIssueTokenClick: vi.fn(),
    onPaste: vi.fn(),
    onPickComposerImages: vi.fn(),
    onSelectComposerProviderCommand: vi.fn(),
    onRespondToApproval: vi.fn(),
    onSelectPendingUserInputOption: vi.fn(),
    onAdvancePendingUserInput: vi.fn(),
    onPreviousPendingQuestion: vi.fn(),
    onRuntimeModeChange: vi.fn(),
    onToggleInteractionMode: vi.fn(),
    onProviderModelSelect: vi.fn(),
    onHandoffToProvider: vi.fn(),
    onPromptChangeFromTraits: vi.fn(),
    onInterrupt: vi.fn(),
    onImplementPlanInNewThread: vi.fn(),
    onQueueMessage: vi.fn(),
    ...overrides,
  };
}

describe("ChatComposerPanel", () => {
  it("does not show a plan indicator when plan mode is off", async () => {
    const screen = await render(<ChatComposerPanel {...buildPanelProps()} />);

    expect(document.querySelector("[data-chat-composer-plan-indicator]")).toBeNull();

    await screen.unmount();
  });

  it("shows a plan indicator when plan mode is on", async () => {
    const onToggleInteractionMode = vi.fn();
    const screen = await render(
      <ChatComposerPanel
        {...buildPanelProps({ interactionMode: "plan", onToggleInteractionMode })}
      />,
    );

    expect(document.querySelector("[data-chat-composer-plan-indicator]")).not.toBeNull();
    expect(document.body.textContent ?? "").toContain("Plan");
    expect(document.body.textContent ?? "").toContain("GPT-5 Codex");

    await page.getByLabelText("Exit plan mode").click();
    expect(onToggleInteractionMode).toHaveBeenCalledTimes(1);

    await screen.unmount();
  });

  it("keeps the plan indicator visible in compact footer layout", async () => {
    const screen = await render(
      <ChatComposerPanel
        {...buildPanelProps({
          interactionMode: "plan",
          isComposerFooterCompact: true,
          isComposerPrimaryActionsCompact: true,
        })}
      />,
    );

    expect(document.querySelector("[data-chat-composer-plan-indicator]")).not.toBeNull();
    expect(document.querySelector("[data-chat-composer-runtime-mode]")).not.toBeNull();

    await screen.unmount();
  });

  it("renders pending input requests as an inset backplate above the composer", async () => {
    const screen = await render(
      <ChatComposerPanel
        {...buildPanelProps({
          pendingUserInputs: [
            {
              requestId: ApprovalRequestId.makeUnsafe("input-request-1"),
              createdAt: new Date().toISOString(),
              questions: [
                {
                  id: "direction",
                  header: "Direction",
                  question: "Which direction should I take first in this workspace?",
                  options: [
                    {
                      label: "Stabilize/fix bug",
                      description: "Focus on reliability or runtime correctness.",
                    },
                    {
                      label: "Feature update",
                      description: "Adjust functionality and tests.",
                    },
                  ],
                  multiSelect: false,
                },
              ],
            },
          ],
          activePendingDraftAnswers: {
            direction: { selectedOptionLabel: "Stabilize/fix bug" },
          },
          activePendingProgress: {
            questionIndex: 0,
            isLastQuestion: true,
            canAdvance: true,
            customAnswer: "",
          },
        })}
      />,
    );

    expect(document.body.textContent ?? "").toContain("Which direction should I take first");
    expect(document.body.textContent ?? "").toContain("Stabilize/fix bug");
    expect(document.querySelector("[aria-pressed='true']")).not.toBeNull();
    expect(document.querySelector("[data-chat-composer-form='true'] .-mb-4")).not.toBeNull();

    await screen.unmount();
  });
});
