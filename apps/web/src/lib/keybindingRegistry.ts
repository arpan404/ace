import {
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingShortcut,
  type StaticKeybindingCommand,
} from "@ace/contracts";
import { formatShortcutLabel, type ShortcutMatchContext } from "~/keybindings";

type KeybindingCategory =
  | "Sidebar"
  | "Chat"
  | "Right Panel"
  | "Terminal"
  | "Browser"
  | "Editor"
  | "Threads";

interface KeybindingDefinitionMeta {
  readonly category: KeybindingCategory;
  readonly label: string;
  readonly description: string;
  readonly defaultShortcut?: KeybindingShortcut;
  readonly when?: string;
  readonly context?: Partial<ShortcutMatchContext>;
}

export interface KeybindingCommandDefinition extends KeybindingDefinitionMeta {
  readonly command: StaticKeybindingCommand;
}

const TERMINAL_FOCUS_CONTEXT: Partial<ShortcutMatchContext> = {
  terminalFocus: true,
  terminalOpen: true,
};

const CHAT_CONTEXT: Partial<ShortcutMatchContext> = {
  terminalFocus: false,
};

const BROWSER_CONTEXT: Partial<ShortcutMatchContext> = {
  browserOpen: true,
  terminalFocus: false,
};

const EDITOR_CONTEXT: Partial<ShortcutMatchContext> = {
  editorFocus: true,
};

const KEYBINDING_DEFINITION_BY_COMMAND: Record<StaticKeybindingCommand, KeybindingDefinitionMeta> =
  {
    "search.open": {
      category: "Sidebar",
      label: "Open search",
      description: "Open the command search panel.",
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "sidebar.toggle": {
      category: "Sidebar",
      label: "Toggle sidebar",
      description: "Collapse or expand the main sidebar.",
    },
    "navigation.back": {
      category: "Sidebar",
      label: "Navigate back",
      description: "Go back in app history.",
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "navigation.forward": {
      category: "Sidebar",
      label: "Navigate forward",
      description: "Go forward in app history.",
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "project.add": {
      category: "Sidebar",
      label: "Add project",
      description: "Open the add project command browser.",
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "terminal.toggle": {
      category: "Terminal",
      label: "Toggle terminal drawer",
      description: "Show or hide the thread terminal drawer.",
    },
    "terminal.split": {
      category: "Terminal",
      label: "Split terminal",
      description: "Split the focused terminal session.",
      when: "terminalFocus",
      context: TERMINAL_FOCUS_CONTEXT,
    },
    "terminal.new": {
      category: "Terminal",
      label: "New terminal",
      description: "Create a new terminal in the active thread.",
      when: "terminalFocus",
      context: TERMINAL_FOCUS_CONTEXT,
    },
    "terminal.close": {
      category: "Terminal",
      label: "Close terminal",
      description: "Close the focused terminal session.",
      when: "terminalFocus",
      context: TERMINAL_FOCUS_CONTEXT,
    },
    "rightPanel.toggle": {
      category: "Right Panel",
      label: "Toggle right side panel",
      description: "Show or hide the right side panel without selecting a Review tab.",
      defaultShortcut: {
        key: "b",
        modKey: true,
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: false,
      },
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "rightPanel.review.open": {
      category: "Right Panel",
      label: "Open Review tab",
      description: "Open and focus the Review tab in the right side panel.",
      defaultShortcut: {
        key: "d",
        modKey: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "rightPanel.browser.open": {
      category: "Right Panel",
      label: "Open Browser tab",
      description: "Open and focus the Browser tab in the right side panel.",
      defaultShortcut: {
        key: "b",
        modKey: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "browser.back": {
      category: "Browser",
      label: "Browser back",
      description: "Navigate browser history backward.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.forward": {
      category: "Browser",
      label: "Browser forward",
      description: "Navigate browser history forward.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.newTab": {
      category: "Right Panel",
      label: "Add Browser tab",
      description: "Open a Browser tab in the right side panel.",
      defaultShortcut: {
        key: "t",
        modKey: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "browser.closeTab": {
      category: "Browser",
      label: "Close browser tab",
      description: "Close the active browser tab.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.focusAddressBar": {
      category: "Browser",
      label: "Focus browser address bar",
      description: "Move focus to the browser address bar.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.reload": {
      category: "Browser",
      label: "Browser reload",
      description: "Reload the active browser tab.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.devtools": {
      category: "Browser",
      label: "Toggle browser DevTools",
      description: "Open or close browser DevTools.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.previousTab": {
      category: "Browser",
      label: "Previous browser tab",
      description: "Activate the previous browser tab.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.nextTab": {
      category: "Browser",
      label: "Next browser tab",
      description: "Activate the next browser tab.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.designer.cursor": {
      category: "Browser",
      label: "Designer cursor tool",
      description: "Toggle the browser designer cursor tool.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.designer.areaComment": {
      category: "Browser",
      label: "Designer area comment tool",
      description: "Toggle the browser designer area comment tool.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.designer.drawComment": {
      category: "Browser",
      label: "Designer draw comment tool",
      description: "Toggle the browser designer draw comment tool.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "browser.designer.elementComment": {
      category: "Browser",
      label: "Designer element comment tool",
      description: "Toggle the browser designer element comment tool.",
      when: "browserOpen && !terminalFocus",
      context: BROWSER_CONTEXT,
    },
    "chat.new": {
      category: "Chat",
      label: "New thread",
      description: "Create a new thread from the current project context.",
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "chat.newLocal": {
      category: "Chat",
      label: "New local thread",
      description: "Create a new thread in local mode.",
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "chat.toggleWorkspaceMode": {
      category: "Chat",
      label: "Toggle workspace mode",
      description: "Switch between chat and editor workspace modes.",
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "chat.togglePlanMode": {
      category: "Chat",
      label: "Toggle plan mode",
      description: "Switch the composer between plan and execute modes.",
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "chat.toggleHeader": {
      category: "Chat",
      label: "Toggle top header",
      description: "Show or hide the chat top header.",
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "rightPanel.editor.open": {
      category: "Right Panel",
      label: "Open Editor tab",
      description: "Open and focus the Editor tab in the right side panel.",
      defaultShortcut: {
        key: "e",
        modKey: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      },
      when: "!terminalFocus",
      context: CHAT_CONTEXT,
    },
    "editor.openFavorite": {
      category: "Editor",
      label: "Open favorite editor",
      description: "Open the active project/worktree in your preferred editor.",
    },
    "editor.newFile": {
      category: "Editor",
      label: "New file",
      description: "Create a new file in the workspace.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.newFolder": {
      category: "Editor",
      label: "New folder",
      description: "Create a new folder in the workspace.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.rename": {
      category: "Editor",
      label: "Rename entry",
      description: "Rename the selected file or folder.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.split": {
      category: "Editor",
      label: "Split editor window",
      description: "Split the focused editor into a new pane.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.splitDown": {
      category: "Editor",
      label: "Split editor down",
      description: "Split the focused editor downward.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.toggleWordWrap": {
      category: "Editor",
      label: "Toggle word wrap",
      description: "Toggle word wrap in the active editor.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.closeTab": {
      category: "Editor",
      label: "Close tab",
      description: "Close the active editor tab.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.closeOtherTabs": {
      category: "Editor",
      label: "Close other tabs",
      description: "Close all tabs except the active one.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.closeTabsToRight": {
      category: "Editor",
      label: "Close tabs to the right",
      description: "Close tabs to the right of the active tab.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.reopenClosedTab": {
      category: "Editor",
      label: "Reopen closed tab",
      description: "Reopen the most recently closed editor tab.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.closeWindow": {
      category: "Editor",
      label: "Close editor window",
      description: "Close the focused editor window.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.focusNextWindow": {
      category: "Editor",
      label: "Focus next window",
      description: "Move focus to the next editor window.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.focusPreviousWindow": {
      category: "Editor",
      label: "Focus previous window",
      description: "Move focus to the previous editor window.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.nextTab": {
      category: "Editor",
      label: "Next tab",
      description: "Focus the next tab in the active editor window.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.previousTab": {
      category: "Editor",
      label: "Previous tab",
      description: "Focus the previous tab in the active editor window.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.moveTabLeft": {
      category: "Editor",
      label: "Move tab left",
      description: "Move the active tab to the left.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "editor.moveTabRight": {
      category: "Editor",
      label: "Move tab right",
      description: "Move the active tab to the right.",
      when: "editorFocus",
      context: EDITOR_CONTEXT,
    },
    "thread.previous": {
      category: "Threads",
      label: "Previous thread",
      description: "Switch to the previous visible thread.",
    },
    "thread.next": {
      category: "Threads",
      label: "Next thread",
      description: "Switch to the next visible thread.",
    },
    "thread.jump.1": {
      category: "Threads",
      label: "Jump to thread 1",
      description: "Jump to the first visible thread.",
    },
    "thread.jump.2": {
      category: "Threads",
      label: "Jump to thread 2",
      description: "Jump to the second visible thread.",
    },
    "thread.jump.3": {
      category: "Threads",
      label: "Jump to thread 3",
      description: "Jump to the third visible thread.",
    },
    "thread.jump.4": {
      category: "Threads",
      label: "Jump to thread 4",
      description: "Jump to the fourth visible thread.",
    },
    "thread.jump.5": {
      category: "Threads",
      label: "Jump to thread 5",
      description: "Jump to the fifth visible thread.",
    },
    "thread.jump.6": {
      category: "Threads",
      label: "Jump to thread 6",
      description: "Jump to the sixth visible thread.",
    },
    "thread.jump.7": {
      category: "Threads",
      label: "Jump to thread 7",
      description: "Jump to the seventh visible thread.",
    },
    "thread.jump.8": {
      category: "Threads",
      label: "Jump to thread 8",
      description: "Jump to the eighth visible thread.",
    },
    "thread.jump.9": {
      category: "Threads",
      label: "Jump to thread 9",
      description: "Jump to the ninth visible thread.",
    },
  };

const HIDDEN_KEYBINDING_COMMANDS = new Set<StaticKeybindingCommand>(["terminal.split"]);

export const KEYBINDING_COMMAND_DEFINITIONS: readonly KeybindingCommandDefinition[] =
  STATIC_KEYBINDING_COMMANDS.filter((command) => !HIDDEN_KEYBINDING_COMMANDS.has(command)).map(
    (command) => Object.assign({ command }, KEYBINDING_DEFINITION_BY_COMMAND[command]),
  );

export function defaultShortcutLabelForCommand(
  command: StaticKeybindingCommand,
  platform?: string,
): string | null {
  const shortcut = KEYBINDING_DEFINITION_BY_COMMAND[command].defaultShortcut;
  return shortcut ? formatShortcutLabel(shortcut, platform) : null;
}
