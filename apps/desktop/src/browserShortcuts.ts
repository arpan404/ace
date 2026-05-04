import type { BrowserShortcutAction } from "@ace/contracts";

function isForwardedKeyInputType(type: string): boolean {
  return type === "keyDown" || type === "rawKeyDown";
}

export function resolveBrowserShortcutAction(
  input: Electron.Input,
  platform: NodeJS.Platform = process.platform,
): BrowserShortcutAction | null {
  if (!isForwardedKeyInputType(input.type)) {
    return null;
  }

  const usesMod = platform === "darwin" ? input.meta === true : input.control === true;
  if (!usesMod) {
    return null;
  }

  const key = input.key.toLowerCase();
  if (input.alt === true) {
    if (key === "[") return "move-tab-left";
    if (key === "]") return "move-tab-right";
    if (key === "1") return "designer-area-comment";
    if (key === "2") return "designer-element-comment";
    return null;
  }

  if (input.shift === true) {
    if (key === "d") return "duplicate-tab";
    if (key === "e") return "toggle-designer-mode";
    if (key === "i") return "devtools";
    if (key === "[") return "previous-tab";
    if (key === "]") return "next-tab";
    return null;
  }

  if (key === "[") return "back";
  if (key === "]") return "forward";
  if (key === "l") return "focus-address-bar";
  if (key === "n") return "new-tab";
  if (key === "r") return "reload";
  if (key === "w") return "close-tab";
  if (key >= "1" && key <= "9") {
    return `select-tab-${key}` as BrowserShortcutAction;
  }

  return null;
}
