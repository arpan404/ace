import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type ResolvedKeybindingRule,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type ThreadJumpKeybindingCommand,
} from "@ace/contracts";
import { isMacPlatform } from "./lib/utils";

export interface ShortcutEventLike {
  type?: string;
  code?: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutMatchContext {
  terminalFocus: boolean;
  terminalOpen: boolean;
  [key: string]: boolean;
}

interface ShortcutMatchOptions {
  platform?: string;
  context?: Partial<ShortcutMatchContext>;
}

interface ResolvedShortcutLabelOptions extends ShortcutMatchOptions {
  platform?: string;
}

const TERMINAL_WORD_BACKWARD = "\u001bb";
const TERMINAL_WORD_FORWARD = "\u001bf";
const TERMINAL_LINE_START = "\u0001";
const TERMINAL_LINE_END = "\u0005";
const EVENT_CODE_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  BracketLeft: ["["],
  BracketRight: ["]"],
  Digit0: ["0"],
  Digit1: ["1"],
  Digit2: ["2"],
  Digit3: ["3"],
  Digit4: ["4"],
  Digit5: ["5"],
  Digit6: ["6"],
  Digit7: ["7"],
  Digit8: ["8"],
  Digit9: ["9"],
};

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const keys = new Set([normalizeEventKey(event.key)]);
  const aliases = event.code ? EVENT_CODE_KEY_ALIASES[event.code] : undefined;
  if (!aliases) return keys;

  for (const alias of aliases) {
    keys.add(alias);
  }
  return keys;
}

function matchesShortcutModifiers(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  if (!matchesShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}

function resolvePlatform(options: ShortcutMatchOptions | undefined): string {
  return options?.platform ?? navigator.platform;
}

function resolveContext(options: ShortcutMatchOptions | undefined): ShortcutMatchContext {
  return {
    terminalFocus: false,
    terminalOpen: false,
    ...options?.context,
  };
}

function evaluateWhenNode(node: KeybindingWhenNode, context: ShortcutMatchContext): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
}

function matchesWhenClause(
  whenAst: KeybindingWhenNode | undefined,
  context: ShortcutMatchContext,
): boolean {
  if (!whenAst) return true;
  return evaluateWhenNode(whenAst, context);
}

function shortcutConflictKey(shortcut: KeybindingShortcut, platform = navigator.platform): string {
  const useMetaForMod = isMacPlatform(platform);
  const metaKey = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const ctrlKey = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);

  return [
    shortcut.key,
    metaKey ? "meta" : "",
    ctrlKey ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}

function normalizeCaptureKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return " ";
  if (normalized === "esc") return "escape";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (/^f\d{1,2}$/.test(normalized)) return normalized;
  if (
    normalized === "enter" ||
    normalized === "tab" ||
    normalized === "backspace" ||
    normalized === "delete" ||
    normalized === "home" ||
    normalized === "end" ||
    normalized === "pageup" ||
    normalized === "pagedown"
  ) {
    return normalized;
  }
  return null;
}

function encodeShortcutKeyToken(key: string): string {
  if (key === " ") return "space";
  if (key === "escape") return "esc";
  return key;
}

function findEffectiveBindingForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): ResolvedKeybindingRule | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const claimedShortcuts = new Set<string>();

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;

    const conflictKey = shortcutConflictKey(binding.shortcut, platform);
    if (claimedShortcuts.has(conflictKey)) {
      continue;
    }

    claimedShortcuts.add(conflictKey);
    if (binding.command === command) {
      return binding;
    }
  }

  return null;
}

function findEffectiveShortcutForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): KeybindingShortcut | null {
  const binding = findEffectiveBindingForCommand(keybindings, command, options);
  return binding?.shortcut ?? null;
}

function matchesCommandShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): boolean {
  return resolveShortcutCommand(event, keybindings, options) === command;
}

export function resolveShortcutCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    if (!matchesShortcut(event, binding.shortcut, platform)) continue;
    return binding.command;
  }
  return null;
}

function formatShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "Up";
  if (key === "arrowdown") return "Down";
  if (key === "arrowleft") return "Left";
  if (key === "arrowright") return "Right";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const useMetaForMod = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  const showAlt = shortcut.altKey;
  const showShift = shortcut.shiftKey;

  if (useMetaForMod) {
    return `${showCtrl ? "\u2303" : ""}${showAlt ? "\u2325" : ""}${showShift ? "\u21e7" : ""}${showMeta ? "\u2318" : ""}${keyLabel}`;
  }

  const parts: string[] = [];
  if (showCtrl) parts.push("Ctrl");
  if (showAlt) parts.push("Alt");
  if (showShift) parts.push("Shift");
  if (showMeta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

export function shortcutLabelForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: string | ResolvedShortcutLabelOptions,
): string | null {
  const resolvedOptions =
    typeof options === "string"
      ? ({ platform: options } satisfies ResolvedShortcutLabelOptions)
      : options;
  const platform = resolvePlatform(resolvedOptions);
  const shortcut = findEffectiveShortcutForCommand(keybindings, command, resolvedOptions);
  return shortcut ? formatShortcutLabel(shortcut, platform) : null;
}

export function shortcutValueForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): string | null {
  const shortcut = findEffectiveShortcutForCommand(keybindings, command, options);
  return shortcut ? encodeShortcutValue(shortcut) : null;
}

export function effectiveBindingForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): ResolvedKeybindingRule | null {
  return findEffectiveBindingForCommand(keybindings, command, options);
}

export function encodeShortcutValue(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(encodeShortcutKeyToken(shortcut.key));
  return parts.join("+");
}

export function shortcutCollisionSignature(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  return shortcutConflictKey(shortcut, platform);
}

export function shortcutFromKeyboardEvent(
  event: ShortcutEventLike,
  options?: { platform?: string },
): KeybindingShortcut | null {
  const keyToken = normalizeCaptureKeyToken(event.key);
  if (!keyToken) return null;

  const platform = options?.platform ?? navigator.platform;
  const useMetaForMod = isMacPlatform(platform);
  const usePrimaryModifierOnly = useMetaForMod
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;

  return {
    key: keyToken,
    metaKey: usePrimaryModifierOnly && useMetaForMod ? false : event.metaKey,
    ctrlKey: usePrimaryModifierOnly && !useMetaForMod ? false : event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    modKey: usePrimaryModifierOnly,
  };
}

export function whenExpressionFromAst(node: KeybindingWhenNode): string {
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!(${whenExpressionFromAst(node.node)})`;
    case "and":
      return `(${whenExpressionFromAst(node.left)} && ${whenExpressionFromAst(node.right)})`;
    case "or":
      return `(${whenExpressionFromAst(node.left)} || ${whenExpressionFromAst(node.right)})`;
  }
}

export function threadJumpCommandForIndex(index: number): ThreadJumpKeybindingCommand | null {
  return THREAD_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function threadJumpIndexFromCommand(command: string): number | null {
  const index = THREAD_JUMP_KEYBINDING_COMMANDS.indexOf(command as ThreadJumpKeybindingCommand);
  return index === -1 ? null : index;
}

export function threadTraversalDirectionFromCommand(
  command: string | null,
): "previous" | "next" | null {
  if (command === "thread.previous") return "previous";
  if (command === "thread.next") return "next";
  return null;
}

export function shouldShowThreadJumpHints(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  const platform = resolvePlatform(options);

  for (const command of THREAD_JUMP_KEYBINDING_COMMANDS) {
    const shortcut = findEffectiveShortcutForCommand(keybindings, command, options);
    if (!shortcut) continue;
    if (matchesShortcutModifiers(event, shortcut, platform)) {
      return true;
    }
  }

  return false;
}

export function isTerminalToggleShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.toggle", options);
}

export function isTerminalSplitShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.split", options);
}

export function isTerminalNewShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.new", options);
}

export function isTerminalCloseShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.close", options);
}

export function isDiffToggleShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "diff.toggle", options);
}

export function isChatNewShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "chat.new", options);
}

export function isChatNewLocalShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "chat.newLocal", options);
}

export function isChatTogglePlanModeShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "chat.togglePlanMode", options);
}

export function isOpenFavoriteEditorShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "editor.openFavorite", options);
}

export function isTerminalClearShortcut(
  event: ShortcutEventLike,
  platform = navigator.platform,
): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }

  const key = event.key.toLowerCase();

  if (key === "l" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return true;
  }

  return (
    isMacPlatform(platform) &&
    key === "k" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function terminalNavigationShortcutData(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (event.shiftKey) return null;

  const key = normalizeEventKey(event.key);
  if (key !== "arrowleft" && key !== "arrowright") {
    return null;
  }

  const moveWord = key === "arrowleft" ? TERMINAL_WORD_BACKWARD : TERMINAL_WORD_FORWARD;
  const moveLine = key === "arrowleft" ? TERMINAL_LINE_START : TERMINAL_LINE_END;

  if (isMacPlatform(platform)) {
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
      return moveWord;
    }
    if (event.metaKey && !event.altKey && !event.ctrlKey) {
      return moveLine;
    }
    return null;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    return moveWord;
  }

  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    return moveWord;
  }

  return null;
}
