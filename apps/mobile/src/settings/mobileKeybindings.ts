import type {
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
  ResolvedKeybindingRule,
} from "@ace/contracts";

export interface MobileKeybindingConflict {
  readonly shortcut: string;
  readonly commands: ReadonlyArray<string>;
  readonly when: string | undefined;
}

export function keybindingCommandLabel(command: string): string {
  return command
    .split(/[.:_-]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function encodeShortcutValue(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key);
  return parts.join("+");
}

export function formatShortcutValue(shortcut: KeybindingShortcut): string {
  return encodeShortcutValue(shortcut)
    .split("+")
    .map((part) => {
      if (part === "mod") return "Cmd/Ctrl";
      if (part === "ctrl") return "Ctrl";
      if (part === "meta") return "Meta";
      if (part === "alt") return "Alt";
      if (part === "shift") return "Shift";
      if (part === "space") return "Space";
      return part.length === 1 ? part.toUpperCase() : keybindingCommandLabel(part);
    })
    .join(" + ");
}

export function keybindingWhenExpression(
  node: ResolvedKeybindingsConfig[number]["whenAst"] | undefined,
): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${keybindingWhenExpression(node.node) ?? ""}`;
    case "and":
      return `${keybindingWhenExpression(node.left) ?? ""} && ${
        keybindingWhenExpression(node.right) ?? ""
      }`;
    case "or":
      return `${keybindingWhenExpression(node.left) ?? ""} || ${
        keybindingWhenExpression(node.right) ?? ""
      }`;
  }
}

function searchableText(binding: ResolvedKeybindingRule): string {
  return [
    binding.command,
    keybindingCommandLabel(binding.command),
    encodeShortcutValue(binding.shortcut),
    formatShortcutValue(binding.shortcut),
    keybindingWhenExpression(binding.whenAst) ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function filterMobileKeybindings(
  bindings: ResolvedKeybindingsConfig,
  query: string,
): ResolvedKeybindingsConfig {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return bindings;
  }
  return bindings.filter((binding) => searchableText(binding).includes(normalizedQuery));
}

export function findMobileKeybindingConflicts(
  bindings: ResolvedKeybindingsConfig,
): ReadonlyArray<MobileKeybindingConflict> {
  const commandBySignature = new Map<string, Set<string>>();
  const metaBySignature = new Map<string, { shortcut: string; when: string | undefined }>();

  for (const binding of bindings) {
    const shortcut = encodeShortcutValue(binding.shortcut);
    const when = keybindingWhenExpression(binding.whenAst);
    const signature = `${shortcut}\u0000${when ?? ""}`;
    const commands = commandBySignature.get(signature) ?? new Set<string>();
    commands.add(binding.command);
    commandBySignature.set(signature, commands);
    metaBySignature.set(signature, { shortcut, when });
  }

  return Array.from(commandBySignature.entries())
    .filter(([, commands]) => commands.size > 1)
    .map(([signature, commands]) => ({
      shortcut: metaBySignature.get(signature)?.shortcut ?? signature,
      commands: Array.from(commands).toSorted((left, right) => left.localeCompare(right)),
      when: metaBySignature.get(signature)?.when,
    }))
    .toSorted((left, right) => left.shortcut.localeCompare(right.shortcut));
}
