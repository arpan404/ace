import type { ProjectScript, ResolvedKeybindingsConfig, ThreadId } from "@ace/contracts";
import { useEffect, useLayoutEffect } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { projectScriptIdFromCommand } from "~/projectScripts";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import type { InAppBrowserController } from "../InAppBrowser";
import type { DockPanelMode } from "./chatViewTypes";

export interface UseChatViewKeyboardShortcutsInput {
  activeThreadId: ThreadId | undefined;
  ownsGlobalSideEffects: boolean;
  shortcutsEnabled: boolean;

  terminalOpen: boolean;
  activeTerminalId: string | null;
  rightSidePanelTerminalOpen: boolean;

  anyBrowserOpen: boolean;
  bottomBrowserInstanceId: string | null;
  rightBrowserInstanceId: string | null;
  browserControllerByThread: Map<string, InAppBrowserController>;

  rightSidePanelOpen: boolean;
  rightSidePanelFullscreen: boolean;
  rightSidePanelMode: string | null;
  bottomPanelElementRef: React.RefObject<HTMLDivElement | null>;
  rightSidePanelElementRef: React.RefObject<HTMLDivElement | null>;

  keybindings: ResolvedKeybindingsConfig;

  activeProject: { scripts: ProjectScript[] } | undefined;

  toggleTerminalVisibility: () => void;
  setTerminalOpen: (open: boolean) => void;
  setBottomPanelMode: (mode: DockPanelMode | null) => void;
  createNewTerminal: () => void;
  createNewPanelTerminal: () => void;
  createSplitTerminal: () => void;
  closeTerminal: (terminalId: string | null) => void;
  onOpenRightSidePanelTerminal: () => void;
  onCloseRightSidePanelTerminal: () => void;
  onOpenBottomPanelDiff: () => void;
  onOpenRightSidePanelDiff: () => void;
  onToggleRightSidePanel: () => void;
  onToggleRightSidePanelFullscreen: () => void;
  onToggleRightSidePanelFloatingChat: () => void;
  openBrowser: () => void;
  onOpenBottomPanelBrowser: () => void;
  onOpenRightSidePanelBrowserTab: () => void;
  onOpenBottomPanelBrowserTab: () => void;
  toggleInteractionMode: () => void;
  toggleWorkspaceMode: () => void;
  onOpenBottomPanelEditor: () => void;
  onOpenRightSidePanelEditor: () => void;
  toggleHeaderVisibility: () => void;
  setTerminalFocusRequestId: (updater: (v: number) => number) => void;
  runProjectScript: (script: ProjectScript) => void;

  expandedImage: { images: Array<{ id: string }> } | null;
  closeExpandedImage: () => void;
  navigateExpandedImage: (delta: number) => void;

  terminalOpenByThreadRef: React.MutableRefObject<Record<string, boolean>>;
  scheduleComposerFocus: () => void;

  browserControllerRef: React.MutableRefObject<InAppBrowserController | null>;
}

export interface UseChatViewKeyboardShortcutsOutput {
  terminalToggleShortcutLabel: string | null;
  newTerminalShortcutLabel: string | null;
  newTerminalTabShortcutLabel: string | null;
  rightSidePanelToggleShortcutLabel: string | null;
  rightSidePanelFullscreenShortcutLabel: string | null;
  rightSidePanelFloatingChatShortcutLabel: string | null;
  reviewPanelShortcutLabel: string | null;
  rightPanelBrowserShortcutLabel: string | null;
  rightPanelEditorShortcutLabel: string | null;
  rightPanelTerminalShortcutLabel: string | null;
  togglePlanModeShortcutLabel: string | null;
  browserBackShortcutLabel: string | null;
  browserForwardShortcutLabel: string | null;
  browserReloadShortcutLabel: string | null;
  browserDevToolsShortcutLabel: string | null;
  browserNewTabShortcutLabel: string | null;
  browserDesignerAreaCommentShortcutLabel: string | null;
  browserDesignerElementCommentShortcutLabel: string | null;
}

export function useChatViewKeyboardShortcuts(
  input: UseChatViewKeyboardShortcutsInput,
): UseChatViewKeyboardShortcutsOutput {
  const {
    activeThreadId,
    ownsGlobalSideEffects,
    shortcutsEnabled,
    terminalOpen,
    activeTerminalId,
    rightSidePanelTerminalOpen,
    anyBrowserOpen,
    bottomBrowserInstanceId,
    rightBrowserInstanceId,
    browserControllerByThread,
    rightSidePanelOpen,
    rightSidePanelFullscreen,
    rightSidePanelMode,
    bottomPanelElementRef,
    rightSidePanelElementRef,
    keybindings,
    activeProject,
    toggleTerminalVisibility,
    setTerminalOpen,
    setBottomPanelMode,
    createNewTerminal,
    createNewPanelTerminal,
    createSplitTerminal,
    closeTerminal,
    onOpenRightSidePanelTerminal,
    onCloseRightSidePanelTerminal,
    onOpenBottomPanelDiff,
    onOpenRightSidePanelDiff,
    onToggleRightSidePanel,
    onToggleRightSidePanelFullscreen,
    onToggleRightSidePanelFloatingChat,
    openBrowser,
    onOpenBottomPanelBrowser,
    onOpenRightSidePanelBrowserTab,
    onOpenBottomPanelBrowserTab,
    toggleInteractionMode,
    toggleWorkspaceMode,
    onOpenBottomPanelEditor,
    onOpenRightSidePanelEditor,
    toggleHeaderVisibility,
    setTerminalFocusRequestId,
    runProjectScript,
    expandedImage,
    closeExpandedImage,
    navigateExpandedImage,
    terminalOpenByThreadRef,
    scheduleComposerFocus,
    browserControllerRef,
  } = input;

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  useLayoutEffect(() => {
    if (!activeThreadId) return;
    const current = Boolean(terminalOpen);
    if (!ownsGlobalSideEffects) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      return;
    }
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      return scheduleComposerFocus();
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [
    activeThreadId,
    ownsGlobalSideEffects,
    scheduleComposerFocus,
    setTerminalFocusRequestId,
    terminalOpen,
    terminalOpenByThreadRef,
  ]);

  const handleGlobalShortcutKeyDown = useStableCallback((event: globalThis.KeyboardEvent) => {
    if (!activeThreadId || event.defaultPrevented) return;
    if (
      event.key === "Escape" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      anyBrowserOpen
    ) {
      browserControllerRef.current?.setDesignerModeActive(false);
    }
    const shortcutContext = {
      terminalFocus: isTerminalFocused(),
      terminalOpen: Boolean(terminalOpen),
      browserOpen: anyBrowserOpen,
      rightPanelOpen: rightSidePanelOpen,
      rightPanelFullscreen: rightSidePanelFullscreen,
    };

    const command = resolveShortcutCommand(event, keybindings, {
      context: shortcutContext,
    });
    if (!command) return;
    const activeElement = document.activeElement;
    const bottomPanelFocused =
      activeElement !== null && bottomPanelElementRef.current?.contains(activeElement) === true;
    const rightSidePanelFocused =
      activeElement !== null && rightSidePanelElementRef.current?.contains(activeElement) === true;
    const shortcutBrowserInstanceId =
      bottomPanelFocused && bottomBrowserInstanceId
        ? bottomBrowserInstanceId
        : rightBrowserInstanceId;
    const activeShortcutBrowserController = shortcutBrowserInstanceId
      ? (browserControllerByThread.get(shortcutBrowserInstanceId) ?? null)
      : null;

    if (command === "terminal.toggle") {
      event.preventDefault();
      event.stopPropagation();
      if (rightSidePanelFocused) {
        if (rightSidePanelTerminalOpen && rightSidePanelMode === "terminal") {
          onCloseRightSidePanelTerminal();
          return;
        }
        onOpenRightSidePanelTerminal();
        return;
      }
      toggleTerminalVisibility();
      return;
    }

    if (command === "terminal.close") {
      event.preventDefault();
      event.stopPropagation();
      if (!terminalOpen && !rightSidePanelTerminalOpen) return;
      closeTerminal(activeTerminalId);
      return;
    }

    if (command === "terminal.new") {
      event.preventDefault();
      event.stopPropagation();
      if (rightSidePanelFocused) {
        onOpenRightSidePanelTerminal();
        createNewPanelTerminal();
        return;
      }
      setTerminalOpen(true);
      setBottomPanelMode("terminal");
      createNewTerminal();
      return;
    }

    if (command === "terminal.tab.new") {
      event.preventDefault();
      event.stopPropagation();
      if (rightSidePanelFocused) {
        onOpenRightSidePanelTerminal();
        createNewPanelTerminal();
        return;
      }
      setTerminalOpen(true);
      setBottomPanelMode("terminal");
      createNewTerminal();
      return;
    }

    if (command === "terminal.split") {
      event.preventDefault();
      event.stopPropagation();
      if (rightSidePanelFocused) {
        onOpenRightSidePanelTerminal();
      } else {
        setTerminalOpen(true);
        setBottomPanelMode("terminal");
      }
      createSplitTerminal();
      return;
    }

    if (command === "rightPanel.review.open") {
      event.preventDefault();
      event.stopPropagation();
      if (bottomPanelFocused) {
        onOpenBottomPanelDiff();
        return;
      }
      onOpenRightSidePanelDiff();
      return;
    }

    if (command === "rightPanel.terminal.open") {
      event.preventDefault();
      event.stopPropagation();
      if (rightSidePanelFocused) {
        onOpenRightSidePanelTerminal();
        return;
      }
      setTerminalOpen(true);
      setBottomPanelMode("terminal");
      setTerminalFocusRequestId((value) => value + 1);
      return;
    }

    if (command === "rightPanel.toggle") {
      event.preventDefault();
      event.stopPropagation();
      onToggleRightSidePanel();
      return;
    }

    if (command === "rightPanel.fullscreen.toggle") {
      event.preventDefault();
      event.stopPropagation();
      if (!rightSidePanelOpen) return;
      onToggleRightSidePanelFullscreen();
      return;
    }

    if (command === "rightPanel.floatingChat.toggle") {
      event.preventDefault();
      event.stopPropagation();
      onToggleRightSidePanelFloatingChat();
      return;
    }

    if (command === "rightPanel.browser.open") {
      event.preventDefault();
      event.stopPropagation();
      if (bottomPanelFocused) {
        onOpenBottomPanelBrowser();
        return;
      }
      openBrowser();
      return;
    }

    if (command === "browser.back") {
      event.preventDefault();
      event.stopPropagation();
      activeShortcutBrowserController?.goBack();
      return;
    }

    if (command === "browser.forward") {
      event.preventDefault();
      event.stopPropagation();
      activeShortcutBrowserController?.goForward();
      return;
    }

    if (command === "browser.reload") {
      event.preventDefault();
      event.stopPropagation();
      activeShortcutBrowserController?.reload();
      return;
    }

    if (command === "browser.devtools") {
      event.preventDefault();
      event.stopPropagation();
      activeShortcutBrowserController?.toggleDevTools();
      return;
    }

    if (command === "browser.newTab") {
      event.preventDefault();
      event.stopPropagation();
      if (!anyBrowserOpen || !activeShortcutBrowserController) {
        if (bottomPanelFocused) {
          onOpenBottomPanelBrowserTab();
          return;
        }
        onOpenRightSidePanelBrowserTab();
        return;
      }
      if (bottomPanelFocused) {
        onOpenBottomPanelBrowser();
      } else {
        openBrowser();
      }
      activeShortcutBrowserController.openNewTab();
      return;
    }

    if (command === "browser.closeTab") {
      event.preventDefault();
      event.stopPropagation();
      activeShortcutBrowserController?.closeActiveTab();
      return;
    }

    if (command === "browser.focusAddressBar") {
      event.preventDefault();
      event.stopPropagation();
      activeShortcutBrowserController?.focusAddressBar();
      return;
    }

    if (command === "browser.previousTab") {
      event.preventDefault();
      event.stopPropagation();
      activeShortcutBrowserController?.goToPreviousTab();
      return;
    }

    if (command === "browser.nextTab") {
      event.preventDefault();
      event.stopPropagation();
      activeShortcutBrowserController?.goToNextTab();
      return;
    }

    if (command === "browser.designer.areaComment") {
      event.preventDefault();
      event.stopPropagation();
      activeShortcutBrowserController?.toggleDesignerTool("area-comment");
      return;
    }

    if (command === "browser.designer.elementComment") {
      event.preventDefault();
      event.stopPropagation();
      activeShortcutBrowserController?.toggleDesignerTool("element-comment");
      return;
    }

    if (command === "chat.togglePlanMode") {
      event.preventDefault();
      event.stopPropagation();
      toggleInteractionMode();
      return;
    }

    if (command === "chat.toggleWorkspaceMode") {
      event.preventDefault();
      event.stopPropagation();
      toggleWorkspaceMode();
      return;
    }

    if (command === "rightPanel.editor.open") {
      event.preventDefault();
      event.stopPropagation();
      if (bottomPanelFocused) {
        onOpenBottomPanelEditor();
        return;
      }
      onOpenRightSidePanelEditor();
      return;
    }

    if (command === "chat.toggleHeader") {
      event.preventDefault();
      event.stopPropagation();
      toggleHeaderVisibility();
      return;
    }

    const scriptId = projectScriptIdFromCommand(command);
    if (!scriptId || !activeProject) return;
    const script = activeProject.scripts.find((entry) => entry.id === scriptId);
    if (!script) return;
    event.preventDefault();
    event.stopPropagation();
    void runProjectScript(script);
  });

  useEffect(() => {
    if (!ownsGlobalSideEffects) return;
    if (!shortcutsEnabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      handleGlobalShortcutKeyDown(event);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleGlobalShortcutKeyDown, ownsGlobalSideEffects, shortcutsEnabled]);

  const terminalShortcutLabelOptions = {
    context: {
      terminalFocus: true,
      terminalOpen: Boolean(terminalOpen),
    },
  };
  const nonTerminalShortcutLabelOptions = {
    context: {
      terminalFocus: false,
      terminalOpen: Boolean(terminalOpen),
    },
  };
  const terminalToggleShortcutLabel = shortcutLabelForCommand(keybindings, "terminal.toggle");
  const newTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.new",
    terminalShortcutLabelOptions,
  );
  const newTerminalTabShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "terminal.tab.new",
    nonTerminalShortcutLabelOptions,
  );
  const rightSidePanelToggleShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "rightPanel.toggle",
    nonTerminalShortcutLabelOptions,
  );
  const rightSidePanelShortcutLabelOptions = {
    context: {
      terminalFocus: false,
      terminalOpen: Boolean(terminalOpen),
      rightPanelOpen: rightSidePanelOpen,
      rightPanelFullscreen: rightSidePanelFullscreen,
    },
  };
  const rightSidePanelFullscreenShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "rightPanel.fullscreen.toggle",
    rightSidePanelShortcutLabelOptions,
  );
  const rightSidePanelFloatingChatShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "rightPanel.floatingChat.toggle",
    rightSidePanelShortcutLabelOptions,
  );
  const reviewPanelShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "rightPanel.review.open",
    nonTerminalShortcutLabelOptions,
  );
  const rightPanelBrowserShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "rightPanel.browser.open",
    nonTerminalShortcutLabelOptions,
  );
  const rightPanelEditorShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "rightPanel.editor.open",
    nonTerminalShortcutLabelOptions,
  );
  const rightPanelTerminalShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "rightPanel.terminal.open",
    nonTerminalShortcutLabelOptions,
  );
  const togglePlanModeShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "chat.togglePlanMode",
    nonTerminalShortcutLabelOptions,
  );
  const browserActionShortcutLabelOptions = {
    context: {
      terminalFocus: false,
      terminalOpen: Boolean(terminalOpen),
      browserOpen: true,
    },
  };
  const browserBackShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "browser.back",
    browserActionShortcutLabelOptions,
  );
  const browserForwardShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "browser.forward",
    browserActionShortcutLabelOptions,
  );
  const browserReloadShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "browser.reload",
    browserActionShortcutLabelOptions,
  );
  const browserDevToolsShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "browser.devtools",
    browserActionShortcutLabelOptions,
  );
  const browserNewTabShortcutLabel =
    shortcutLabelForCommand(keybindings, "browser.newTab", nonTerminalShortcutLabelOptions) ??
    rightPanelBrowserShortcutLabel;
  const browserDesignerAreaCommentShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "browser.designer.areaComment",
    browserActionShortcutLabelOptions,
  );
  const browserDesignerElementCommentShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "browser.designer.elementComment",
    browserActionShortcutLabelOptions,
  );

  return {
    terminalToggleShortcutLabel,
    newTerminalShortcutLabel,
    newTerminalTabShortcutLabel,
    rightSidePanelToggleShortcutLabel,
    rightSidePanelFullscreenShortcutLabel,
    rightSidePanelFloatingChatShortcutLabel,
    reviewPanelShortcutLabel,
    rightPanelBrowserShortcutLabel,
    rightPanelEditorShortcutLabel,
    rightPanelTerminalShortcutLabel,
    togglePlanModeShortcutLabel,
    browserBackShortcutLabel,
    browserForwardShortcutLabel,
    browserReloadShortcutLabel,
    browserDevToolsShortcutLabel,
    browserNewTabShortcutLabel,
    browserDesignerAreaCommentShortcutLabel,
    browserDesignerElementCommentShortcutLabel,
  };
}
